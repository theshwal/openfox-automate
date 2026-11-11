/**
 * Tests for the supported host client (`src/host-client.ts`).
 *
 * Every test uses an injected fake `fetch`: no server is started, no port
 * is contacted, and no real OpenFox instance is involved.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  HostClient,
  buildWorkflowLaunchMessage,
  defaultHostBaseUrl,
  type HostClientResult,
} from '../src/host-client.js'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function client(fetchImpl: typeof fetch, baseUrl = 'http://127.0.0.1:10369'): HostClient {
  return new HostClient({ baseUrl, timeoutMs: 1000 }, { fetchImpl })
}

describe('buildWorkflowLaunchMessage', () => {
  it('builds the host slash syntax with the workflow id first', () => {
    expect(buildWorkflowLaunchMessage('plan-issue-v3', { issue_ref: 'o/r#1' })).toBe('/plan-issue-v3 o/r#1')
  })

  it('respects the declared parameter order', () => {
    const message = buildWorkflowLaunchMessage('plan-issue-v3', { b: 'second', a: 'first' }, ['a', 'b'])
    expect(message).toBe('/plan-issue-v3 first second')
  })

  it('drops empty parameter values', () => {
    expect(buildWorkflowLaunchMessage('wf', { a: '', b: 'kept' }, ['a', 'b'])).toBe('/wf kept')
  })

  it('works without parameters', () => {
    expect(buildWorkflowLaunchMessage('wf')).toBe('/wf')
  })
})

describe('defaultHostBaseUrl', () => {
  it('mirrors the host defaults', () => {
    expect(defaultHostBaseUrl('production')).toBe('http://127.0.0.1:10369')
    expect(defaultHostBaseUrl('development')).toBe('http://127.0.0.1:10469')
  })
})

describe('HostClient — fail closed', () => {
  it('returns not-configured when the base URL is empty (no request attempted)', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const c = new HostClient({ baseUrl: '  ' }, { fetchImpl })
    const result = await c.createSession('p1', 'title')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('not-configured')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns bad-request when projectId is missing', async () => {
    const result = await client(vi.fn() as unknown as typeof fetch).createSession('')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('bad-request')
  })

  it('maps a network error to unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const result = await client(fetchImpl).createSession('p1')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('unreachable')
      expect(result.message).toContain('ECONNREFUSED')
    }
  })

  it('maps 401 to unauthorized', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 })) as unknown as typeof fetch
    const result = await client(fetchImpl).createSession('p1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('unauthorized')
  })

  it('maps 404 to not-found', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch
    const result = await client(fetchImpl).getSession('missing')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('not-found')
  })

  it('maps 409 to conflict', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 409 })) as unknown as typeof fetch
    const result = await client(fetchImpl).sendMessage('s1', 'hello')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('conflict')
  })

  it('maps a 500 to server-error', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 500 })) as unknown as typeof fetch
    const result = await client(fetchImpl).getSession('s1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('server-error')
  })

  it('maps a non-JSON body to invalid-response', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch
    const result = await client(fetchImpl).getSession('s1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-response')
  })

  it('reports invalid-response when the host omits the session id', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(201, { session: {} })) as unknown as typeof fetch
    const result = await client(fetchImpl).createSession('p1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-response')
  })
})

describe('HostClient — supported host API', () => {
  it('creates a session through POST /api/sessions', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(201, { session: { id: 'sess-1', title: 'issue', projectId: 'p1' } }),
    ) as unknown as typeof fetch

    const result = await client(fetchImpl).createSession('p1', 'issue')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.id).toBe('sess-1')

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ]
    expect(url).toBe('http://127.0.0.1:10369/api/sessions')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ projectId: 'p1', title: 'issue' })
  })

  it('launches a workflow through the host TASK BOARD', async () => {
    // The host resolves `/<workflow-id> <args>` ONLY in the task path:
    // `resolveSlashLaunch` has a single call site (`seedSession`). The
    // session-message route queues the raw text as a chat message, so a
    // slash prompt sent there never starts a workflow.
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/tasks')) return jsonResponse(201, { task: { id: 'task-1' } })
      return jsonResponse(200, { task: { id: 'task-1' } })
    }) as unknown as typeof fetch

    const result = await client(fetchImpl).launchWorkflow('proj-1', 'plan-issue-v3', {
      issue_ref: 'o/r#7',
    })
    expect(result.ok).toBe(true)

    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<
      [string, RequestInit]
    >
    // The task is created with the slash prompt…
    expect(calls[0]![0]).toBe('http://127.0.0.1:10369/api/projects/proj-1/tasks')
    expect(JSON.parse(String(calls[0]![1].body))).toEqual({ prompt: '/plan-issue-v3 o/r#7' })
    // …and moved to in_progress, which is what makes the host launch it.
    expect(calls[1]![0]).toBe('http://127.0.0.1:10369/api/projects/proj-1/tasks/task-1/move')
    expect(JSON.parse(String(calls[1]![1].body))).toEqual({ to: 'in_progress' })
  })

  it('sends the session token when configured', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {})) as unknown as typeof fetch
    const c = new HostClient({ baseUrl: 'http://127.0.0.1:10369', token: 'tok-123' }, { fetchImpl })
    await c.getSession('s1')
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers['x-session-token']).toBe('tok-123')
  })

  it('lists the host workflows and flattens the three scopes', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        defaults: [{ id: 'default', name: 'Default' }],
        userItems: [{ id: 'plan-issue-v3' }],
        projectItems: [{ id: 'build-verify-v3' }],
      }),
    ) as unknown as typeof fetch

    const result = await client(fetchImpl).listWorkflows()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.map((w) => w.id)).toEqual(['default', 'plan-issue-v3', 'build-verify-v3'])
    }
  })

  it('never throws — every method returns a result object', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('boom')
    }) as unknown as typeof fetch
    const c = client(fetchImpl)
    const results: HostClientResult<unknown>[] = [
      await c.createSession('p1'),
      await c.getSession('s1'),
      await c.sendMessage('s1', 'x'),
      await c.launchWorkflow('s1', 'wf'),
      await c.stopSession('s1'),
      await c.listWorkflows(),
    ]
    expect(results.every((r) => r.ok === false)).toBe(true)
  })
})
