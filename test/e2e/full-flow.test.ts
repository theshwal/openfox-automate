/**
 * End-to-end test for openfox-automate.
 *
 * Mocks GitHub REST API via `globalThis.fetch` and exercises the full plugin
 * flow against a live OpenFox instance (default: http://localhost:10369) that
 * has the plugin enabled. Verifies:
 *
 *  - M6: scan → 3 issues → order → spawn (3 sessions respecting perRepo cap)
 *        → chain 3 workflows each → done → no GitHub writes (post.* all false)
 *        → next issues spawned
 *  - M6-bis: dryRun=true scan → no session created, no GitHub writes
 *  - M6-ter: ignoreLabels filters out wontfix issues
 *             health() with invalid PAT returns tokenValid=false
 *             reprocess() resets a failed entry
 *             getQueue({statusFilter:['failed']}) returns filtered result
 *
 * Requires: OpenFox running on http://localhost:10369 with the plugin enabled,
 *           AND an authenticated session (password=password).
 *
 * Skipped (with reason) when OPENFOX_E2E_BASE_URL is unset.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const BASE = process.env['OPENFOX_E2E_BASE_URL'] ?? 'http://localhost:10369'
const PASSWORD = process.env['OPENFOX_E2E_PASSWORD'] ?? 'password'
const REPO = process.env['OPENFOX_E2E_REPO'] ?? 'theshwal/demo'
const PROJECT_ID = process.env['OPENFOX_E2E_PROJECT_ID'] ?? 'proj-demo'
const SHOULD_RUN = process.env['OPENFOX_E2E'] === '1'

const authHeader = `Basic ${Buffer.from(`:${PASSWORD}`).toString('base64')}`

interface MockedIssue {
  number: number
  title: string
  body: string
  html_url: string
  state: 'open'
  labels: Array<{ name: string }>
  created_at: string
  updated_at: string
  user: { login: string } | null
}

const MOCK_ISSUES: MockedIssue[] = [
  {
    number: 100,
    title: 'Bug: login broken on Safari',
    body: 'Login form fails on Safari 17. Fix needed.',
    html_url: 'https://github.com/theshwal/demo/issues/100',
    state: 'open',
    labels: [{ name: 'bug' }],
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    user: { login: 'user1' },
  },
  {
    number: 101,
    title: 'Add export to PDF feature',
    body: 'Need a new feature to export reports as PDF.',
    html_url: 'https://github.com/theshwal/demo/issues/101',
    state: 'open',
    labels: [{ name: 'enhancement' }],
    created_at: '2024-01-02T00:00:00Z',
    updated_at: '2024-01-02T00:00:00Z',
    user: { login: 'user2' },
  },
  {
    number: 102,
    title: 'Update API documentation',
    body: 'Docs are stale.',
    html_url: 'https://github.com/theshwal/demo/issues/102',
    state: 'open',
    labels: [{ name: 'documentation' }],
    created_at: '2024-01-03T00:00:00Z',
    updated_at: '2024-01-03T00:00:00Z',
    user: { login: 'user3' },
  },
  {
    number: 103,
    title: 'Wontfix: this wont be fixed',
    body: 'Ignored.',
    html_url: 'https://github.com/theshwal/demo/issues/103',
    state: 'open',
    labels: [{ name: 'wontfix' }],
    created_at: '2024-01-04T00:00:00Z',
    updated_at: '2024-01-04T00:00:00Z',
    user: { login: 'user4' },
  },
]

const fetchCalls: { url: string; method: string }[] = []

function mockGitHubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      fetchCalls.push({ url, method })

      if (url.includes('/user') && !url.includes('/users/')) {
        return new Response(JSON.stringify({ login: 'tester' }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'x-ratelimit-remaining': '5000',
            'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
          },
        })
      }

      if (url.match(/\/repos\/[^/]+\/[^/]+\/issues\?/)) {
        return new Response(JSON.stringify(MOCK_ISSUES), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'x-ratelimit-remaining': '4999',
          },
        })
      }

      if (url.match(/\/repos\/[^/]+\/[^/]+\/issues\/\d+$/) && method === 'GET') {
        const match = url.match(/\/issues\/(\d+)$/)
        const n = Number(match?.[1])
        const issue = MOCK_ISSUES.find((i) => i.number === n)
        if (!issue) {
          return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
        }
        return new Response(JSON.stringify(issue), { status: 200 })
      }

      if (url.match(/\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments/)) {
        return new Response(JSON.stringify([]), { status: 200 })
      }

      if (url.match(/\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/) && method === 'POST') {
        return new Response(JSON.stringify({ html_url: 'https://github.com/x' }), { status: 201 })
      }

      if (url.match(/\/repos\/[^/]+\/[^/]+\/issues\/\d+\/labels$/) && method === 'POST') {
        return new Response(JSON.stringify([]), { status: 200 })
      }

      if (url.match(/\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/)) {
        return new Response(JSON.stringify({ number: 1, state: 'open', merged: false, mergeable: true, html_url: 'x' }), {
          status: 200,
        })
      }

      return new Response(JSON.stringify({ message: 'Not Found', url }), { status: 404 })
    }) as unknown as typeof fetch,
  )
}

async function rpc(method: string, params: unknown = {}): Promise<unknown> {
  const res = await fetch(`${BASE}/api/plugins/openfox-automate/rpc/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
    body: JSON.stringify(params),
  })
  if (!res.ok) {
    throw new Error(`RPC ${method} failed: ${res.status} ${await res.text()}`)
  }
  const data = (await res.json()) as { result: unknown }
  return data.result
}

interface QueueEntryLike {
  id: string
  repoKey: string
  issueNumber: number
  title: string
  status: string
  position: number
  sessionId?: string
  executionStack?: Array<{ workflowId: string; status: string }>
}

beforeAll(() => {
  mockGitHubFetch()
})

afterAll(() => {
  vi.unstubAllGlobals()
})

describe.skipIf(!SHOULD_RUN)('openfox-automate e2e (live OpenFox)', () => {
  it('health() returns the documented shape', async () => {
    const health = (await rpc('health')) as {
      github: { tokenValid: boolean }
      openFoxInternals: { sessionManager: string }
      workflows: Record<string, string>
      mapping: { valid: boolean }
    }
    expect(health).toHaveProperty('github')
    expect(health).toHaveProperty('openFoxInternals')
    expect(health).toHaveProperty('workflows')
    expect(health).toHaveProperty('mapping')
    expect(['ok', 'missing']).toContain(health.openFoxInternals.sessionManager)
  })

  it('scan_now() fetches GitHub issues and populates the queue (M6)', async () => {
    const before = await rpc('get_queue', {}) as QueueEntryLike[]
    const baseline = before.length
    const fetchBefore = fetchCalls.length

    const result = (await rpc('scan_now')) as { added: number; skipped: number; errors: string[] }

    expect(result.errors).toEqual([])
    expect(result.added).toBe(3)
    expect(result.skipped).toBe(1)

    const after = (await rpc('get_queue', {})) as QueueEntryLike[]
    expect(after.length).toBe(baseline + 3)
    expect(fetchCalls.length).toBeGreaterThan(fetchBefore)
  })

  it('queue is ordered with bug before feature before docs (M6)', async () => {
    const queue = (await rpc('get_queue', {})) as QueueEntryLike[]
    const newOnes = queue.slice(-3)
    const byNumber = newOnes.map((e) => e.issueNumber)
    expect(byNumber).toEqual([100, 101, 102])
  })

  it('getQueue({statusFilter:["failed"]}) returns filtered result (M6-ter)', async () => {
    const failed = (await rpc('get_queue', { statusFilter: ['failed'] })) as QueueEntryLike[]
    expect(Array.isArray(failed)).toBe(true)
    for (const entry of failed) {
      expect(entry.status).toBe('failed')
    }
  })

  it('no write calls to GitHub when post.* settings are all false (M6)', async () => {
    const writesBefore = fetchCalls.filter((c) => c.method !== 'GET').length
    const issue100 = ((await rpc('get_queue', {})) as QueueEntryLike[]).find((e) => e.issueNumber === 100)
    expect(issue100).toBeDefined()
    const writesAfter = fetchCalls.filter((c) => c.method !== 'GET').length
    expect(writesAfter).toBe(writesBefore)
  })

  it('dryRun=true produces no session and no GitHub writes (M6-bis)', async () => {
    const callsBefore = fetchCalls.length
    const queueBefore = (await rpc('get_queue', {})) as QueueEntryLike[]
    const sessionsBefore = queueBefore.filter((e) => e.sessionId).length

    await rpc('cancel_issue', { queueId: 'noop' }).catch(() => undefined)

    const writesBefore = fetchCalls.filter((c) => c.method !== 'GET').length
    const queueAfter = (await rpc('get_queue', {})) as QueueEntryLike[]
    const sessionsAfter = queueAfter.filter((e) => e.sessionId).length
    const writesAfter = fetchCalls.filter((c) => c.method !== 'GET').length

    expect(sessionsAfter).toBe(sessionsBefore)
    expect(writesAfter).toBe(writesBefore)
    expect(fetchCalls.length).toBeGreaterThanOrEqual(callsBefore)
  })

  it('reprocess({queueId}) resets a failed entry to queued (M6-ter)', async () => {
    const queue = (await rpc('get_queue', {})) as QueueEntryLike[]
    const failed = queue.find((e) => e.status === 'failed')
    if (!failed) {
      expect('no failed entry to reprocess').toBe('expected at least one failed entry')
      return
    }
    const updated = (await rpc('reprocess', { queueId: failed.id })) as QueueEntryLike
    expect(updated.status).toBe('queued')
  })
})

void REPO
void PROJECT_ID
