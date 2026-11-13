/**
 * AC14 — Integration contract with the OpenFox host (v2.0.161).
 *
 * The contracts are pinned against the host's ACTUAL routes, verified
 * statically in the installed 2.0.161 build:
 *
 *   POST /api/sessions              { projectId, title }   -> 201 { session }
 *   GET  /api/sessions/:id          -> 200 { ...session }
 *   POST /api/sessions/:id/message  { content }            -> 200 { success }
 *   POST /api/sessions/:id/stop     -> 200 { success, queuedMessages }
 *   GET  /api/workflows             -> { defaults, userItems, projectItems }
 *
 * and the auth rule: the `x-session-token` header is only required when
 * the host's auth strategy is "network" AND a password is set. Otherwise
 * the API is open on the loopback interface.
 *
 * NO REQUEST IS EVER SENT: the fetch implementation is a fake that
 * reproduces the host's real status codes and bodies. No server is
 * started, no port is contacted.
 */

import { describe, expect, it, vi } from 'vitest'

import { HostClient, buildWorkflowLaunchMessage, defaultHostBaseUrl } from '../src/host-client.js'

/** A fake that reproduces the host's real answers. */
function fakeHost(routes: Record<string, { status: number; body: unknown }>): {
  fetchImpl: typeof fetch
  calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }>
} {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({
      url,
      method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    // The routes are keyed by the exact path. A single-route fake is
    // matched by method when no exact path is registered, which keeps the
    // fixtures short.
    const path = url.slice(url.indexOf('/', url.indexOf('://') + 3))
    const key = `${method} ${path.split('?')[0]!}`
    const exact = routes[key]
    const byMethod = Object.entries(routes).find(([k]) => k.startsWith(`${method} `))
    const route = exact ?? byMethod?.[1]
    if (!route) {
      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
    }
    return new Response(JSON.stringify(route.body), { status: route.status })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const BASE = 'http://127.0.0.1:10369'

describe('AC14 — host route contracts (2.0.161)', () => {
  it('POST /api/sessions sends { projectId, title } and reads { session }', async () => {
    const { fetchImpl, calls } = fakeHost({
      'POST /api/sessions': {
        status: 201,
        body: { session: { id: 'sess-1', title: '[issue #7] Boom', projectId: 'proj-1' } },
      },
    })
    const client = new HostClient({ baseUrl: BASE }, { fetchImpl })

    const result = await client.createSession('proj-1', '[issue #7] Boom')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.id).toBe('sess-1')

    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.url).toBe(`${BASE}/api/sessions`)
    expect(calls[0]?.body).toEqual({ projectId: 'proj-1', title: '[issue #7] Boom' })
  })

  it('the workflow launch goes through the task board (the only path the host resolves)', async () => {
    // `resolveSlashLaunch` has exactly ONE call site in the host: the task
    // path (`seedSession`). `POST /api/sessions/:id/message` only queues
    // the raw text and the queue processor runs a plain chat turn, so a
    // `/<workflow-id>` prompt sent there is delivered literally.
    const { fetchImpl, calls } = fakeHost({
      'POST /api/projects/proj-1/tasks': { status: 201, body: { task: { id: 'task-1' } } },
      'POST /api/projects/proj-1/tasks/task-1/move': { status: 200, body: { task: { id: 'task-1' } } },
    })
    const client = new HostClient({ baseUrl: BASE }, { fetchImpl })

    const result = await client.launchWorkflow('proj-1', 'plan-issue-v3', { issue_ref: 'o/r#7' })
    expect(result.ok).toBe(true)

    expect(calls[0]?.url).toBe(`${BASE}/api/projects/proj-1/tasks`)
    expect(calls[0]?.body).toEqual({ prompt: '/plan-issue-v3 o/r#7' })
    expect(calls[1]?.url).toBe(`${BASE}/api/projects/proj-1/tasks/task-1/move`)
    expect(calls[1]?.body).toEqual({ to: 'in_progress' })
  })

  it('POST /api/sessions/:id/stop reads { success, queuedMessages }', async () => {
    const { fetchImpl, calls } = fakeHost({
      'POST /api/sessions/sess-1/stop': { status: 200, body: { success: true, queuedMessages: [] } },
    })
    const client = new HostClient({ baseUrl: BASE }, { fetchImpl })

    const result = await client.stopSession('sess-1')
    expect(result.ok).toBe(true)
    expect(calls[0]?.url).toBe(`${BASE}/api/sessions/sess-1/stop`)
  })

  it('GET /api/workflows reads the three scopes', async () => {
    const { fetchImpl } = fakeHost({
      'GET /api/workflows': {
        status: 200,
        body: {
          defaults: [{ id: 'default', name: 'Default' }],
          userItems: [{ id: 'plan-issue-v3', name: 'Plan Issue v3' }],
          projectItems: [{ id: 'build-verify-v3', name: 'Build & Verify v3' }],
        },
      },
    })
    const client = new HostClient({ baseUrl: BASE }, { fetchImpl })

    const result = await client.listWorkflows()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.map((w) => w.id)).toEqual(['default', 'plan-issue-v3', 'build-verify-v3'])
    }
  })
})

describe('AC14 — auth and error handling', () => {
  it('sends no token when none is configured (local auth strategy)', async () => {
    const { fetchImpl, calls } = fakeHost({ 'GET /api/sessions/sess-1': { status: 200, body: {} } })
    const client = new HostClient({ baseUrl: BASE }, { fetchImpl })
    await client.getSession('sess-1')
    expect(calls[0]?.headers['x-session-token']).toBeUndefined()
  })

  it('sends the token when the host requires network auth', async () => {
    const { fetchImpl, calls } = fakeHost({ 'GET /api/sessions/sess-1': { status: 200, body: {} } })
    const client = new HostClient({ baseUrl: BASE, token: 'secret-token' }, { fetchImpl })
    await client.getSession('sess-1')
    expect(calls[0]?.headers['x-session-token']).toBe('secret-token')
  })

  it('maps 401 to unauthorized (the host rejected the token)', async () => {
    const { fetchImpl } = fakeHost({
      'GET /api/sessions/sess-1': { status: 401, body: { error: 'Unauthorized' } },
    })
    const client = new HostClient({ baseUrl: BASE, token: 'bad' }, { fetchImpl })
    const result = await client.getSession('sess-1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('unauthorized')
  })

  it('maps 404 to not-found (unknown session or workflow)', async () => {
    const { fetchImpl } = fakeHost({
      'GET /api/sessions/nope': { status: 404, body: { error: 'Session not found' } },
    })
    const client = new HostClient({ baseUrl: BASE }, { fetchImpl })
    const result = await client.getSession('nope')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('not-found')
  })

  it('maps 400 to bad-request (the host refused the payload)', async () => {
    const { fetchImpl } = fakeHost({
      'POST /api/projects/proj-1/tasks': {
        status: 400,
        body: { error: 'prompt is required' },
      },
    })
    const client = new HostClient({ baseUrl: BASE }, { fetchImpl })
    const result = await client.launchWorkflow('proj-1', 'plan-issue-v3', { issue_ref: 'o/r#7' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('bad-request')
  })

  it('maps 409 to conflict (the task is already running)', async () => {
    const { fetchImpl } = fakeHost({
      'POST /api/projects/proj-1/tasks': { status: 201, body: { task: { id: 'task-1' } } },
      'POST /api/projects/proj-1/tasks/task-1/move': {
        status: 409,
        body: { error: 'Task is already running' },
      },
    })
    const client = new HostClient({ baseUrl: BASE }, { fetchImpl })
    const result = await client.launchWorkflow('proj-1', 'plan-issue-v3', { issue_ref: 'o/r#7' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('conflict')
  })

  it('maps a timeout to unreachable and aborts the request', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const client = new HostClient({ baseUrl: BASE, timeoutMs: 20 }, { fetchImpl })
    const result = await client.getSession('sess-1')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('unreachable')
      expect(result.message).toContain('timed out')
    }
  })

  it('never leaks the token into the URL or into an error message', async () => {
    const { fetchImpl, calls } = fakeHost({
      'GET /api/sessions/sess-1': { status: 500, body: { error: 'boom' } },
    })
    const client = new HostClient({ baseUrl: BASE, token: 'super-secret' }, { fetchImpl })
    const result = await client.getSession('sess-1')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(JSON.stringify(result)).not.toContain('super-secret')
    }
    expect(calls[0]?.url).not.toContain('super-secret')
  })
})

describe('AC14 — the base URL is validated (no SSRF through the setting)', () => {
  it('accepts the loopback origins the host actually uses', async () => {
    const { fetchImpl } = fakeHost({ 'GET /api/sessions/sess-1': { status: 200, body: {} } })
    for (const base of ['http://127.0.0.1:10369', 'http://localhost:10369', 'http://[::1]:10369']) {
      const client = new HostClient({ baseUrl: base }, { fetchImpl })
      const result = await client.getSession('sess-1')
      expect(result.ok).toBe(true)
    }
  })

  it('refuses a non-loopback host WITHOUT sending the token', async () => {
    const { fetchImpl, calls } = fakeHost({ 'GET /api/sessions/sess-1': { status: 200, body: {} } })
    const client = new HostClient(
      { baseUrl: 'http://evil.example.com:10369', token: 'super-secret' },
      { fetchImpl },
    )
    const result = await client.getSession('sess-1')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('bad-request')
      expect(result.message).toContain('loopback')
    }
    // No request was made at all: the token never left.
    expect(calls).toHaveLength(0)
  })

  it('refuses a non-HTTP scheme', async () => {
    const { fetchImpl, calls } = fakeHost({ 'GET /api/sessions/sess-1': { status: 200, body: {} } })
    const client = new HostClient({ baseUrl: 'file:///etc/passwd' }, { fetchImpl })
    const result = await client.getSession('sess-1')
    expect(result.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })
})

describe('AC14 — workflow parameter mapping', () => {
  it('maps the parameters onto the positional arguments the host expects', () => {
    // The host parses `/<id> <arg> <arg>` and maps the positional
    // arguments onto the workflow's declared parameters (sorted by
    // position). The values therefore arrive ALREADY in the declared
    // order — the mapping is done by `mapDeclaredParameters`, which
    // refuses to guess when the declaration cannot be read.
    expect(
      buildWorkflowLaunchMessage('plan-issue-v3', { issue_ref: 'o/r#7', repo: 'o/r' }, ['o/r#7', 'o/r']),
    ).toBe('/plan-issue-v3 o/r#7 o/r')
  })

  it('produces the exact message the host resolves', () => {
    expect(buildWorkflowLaunchMessage('publish-pr-v1')).toBe('/publish-pr-v1')
  })

  it('lists the three scopes the host exposes (read-only access)', async () => {
    // The user-level workflows are READ through `GET /api/workflows`: the
    // plugin never writes to the host's workflow directories, and the
    // route is a plain GET.
    const { fetchImpl, calls } = fakeHost({
      'GET /api/workflows': {
        status: 200,
        body: {
          defaults: [{ id: 'default' }],
          userItems: [{ id: 'plan-issue-v3' }, { id: 'build-verify-v3' }, { id: 'publish-pr-v1' }],
          projectItems: [],
        },
      },
    })
    const client = new HostClient({ baseUrl: BASE }, { fetchImpl })
    const result = await client.listWorkflows()
    expect(result.ok).toBe(true)
    if (result.ok) {
      const ids = result.value.map((w) => w.id)
      expect(ids).toContain('plan-issue-v3')
      expect(ids).toContain('build-verify-v3')
      expect(ids).toContain('publish-pr-v1')
    }
    expect(calls[0]?.method).toBe('GET')
  })

  it('uses the host default ports', () => {
    expect(defaultHostBaseUrl('production')).toBe('http://127.0.0.1:10369')
    expect(defaultHostBaseUrl('development')).toBe('http://127.0.0.1:10469')
  })
})
