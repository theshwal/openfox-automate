import { afterEach, describe, expect, it, vi } from 'vitest'
import { monitorPRs } from '../src/pr-monitor.js'
import { QueueStore } from '../src/queue.js'
import type { QueueEntry } from '../src/types.js'

function entry(partial: Partial<QueueEntry>): QueueEntry {
  return {
    id: 'qe1',
    repoKey: 'o/r',
    projectId: 'p',
    issueNumber: 1,
    title: 'T',
    body: '',
    url: '',
    labels: [],
    comments: [],
    dependsOn: [],
    status: 'running',
    position: 1,
    addedAt: '2024-01-01T00:00:00Z',
    prUrl: 'https://github.com/o/r/pull/42',
    ...partial,
  }
}

function makeStore(initial: QueueEntry[]): { store: QueueStore; backing: Map<string, unknown> } {
  const backing = new Map<string, unknown>([
    ['queue', initial],
    ['history', []],
  ])
  const store = new QueueStore({
    get: async (k) => backing.get(k),
    set: async (k, v) => {
      backing.set(k, v)
    },
  })
  return { store, backing }
}

function mockFetch(responses: Record<string, { ok: boolean; status: number; body: unknown }>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      const match = Object.keys(responses).find((k) => url.includes(k))
      if (!match) {
        return new Response(JSON.stringify({ message: 'Not Found', url }), { status: 404 })
      }
      const r = responses[match]!
      return new Response(JSON.stringify(r.body), { status: r.status })
    }) as unknown as typeof fetch,
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('monitorPRs', () => {
  it('returns early when no entries have a prUrl', async () => {
    const { store } = makeStore([entry({ id: 'a', status: 'running' }), entry({ id: 'b', status: 'queued' })])
    const notify = vi.fn()
    const result = await monitorPRs({
      token: 'tok',
      store,
      notify,
      republish: vi.fn(),
    })
    expect(result.checked).toBe(0)
    expect(result.completed).toBe(0)
    expect(result.failed).toBe(0)
    expect(notify).not.toHaveBeenCalled()
  })

  it('PR4: marks entry done when merged=true', async () => {
    const { store, backing } = makeStore([
      entry({ id: 'merge-me', status: 'running', prUrl: 'https://github.com/o/r/pull/7' }),
    ])
    mockFetch({
      '/pulls/7': {
        ok: true,
        status: 200,
        body: { number: 7, state: 'open', merged: true, mergeable: true, html_url: 'x' },
      },
    })
    const notify = vi.fn()
    const result = await monitorPRs({
      token: 'tok',
      store,
      notify,
      republish: vi.fn(),
    })
    expect(result.checked).toBe(1)
    expect(result.completed).toBe(1)
    const history = backing.get('history') as QueueEntry[]
    expect(history[0]?.id).toBe('merge-me')
    expect(history[0]?.status).toBe('done')
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ level: 'success' }))
  })

  it('PR3: marks entry failed when mergeable=false and state=open', async () => {
    const { store, backing } = makeStore([
      entry({ id: 'conflict', status: 'running', prUrl: 'https://github.com/o/r/pull/8' }),
    ])
    mockFetch({
      '/pulls/8': {
        ok: true,
        status: 200,
        body: { number: 8, state: 'open', merged: false, mergeable: false, html_url: 'x' },
      },
    })
    const notify = vi.fn()
    const result = await monitorPRs({
      token: 'tok',
      store,
      notify,
      republish: vi.fn(),
    })
    expect(result.checked).toBe(1)
    expect(result.failed).toBe(1)
    const history = backing.get('history') as QueueEntry[]
    expect(history[0]?.id).toBe('conflict')
    expect(history[0]?.status).toBe('failed')
    expect(history[0]?.error).toBe('pr_conflicts')
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warning',
        actions: expect.arrayContaining([
          expect.objectContaining({ onActivate: expect.objectContaining({ method: 'automate.reprocess' }) }),
        ]),
      }),
    )
  })

  it('PR2: leaves entry unchanged when mergeable=true and not merged', async () => {
    const { store, backing } = makeStore([
      entry({ id: 'healthy', status: 'running', prUrl: 'https://github.com/o/r/pull/9' }),
    ])
    mockFetch({
      '/pulls/9': {
        ok: true,
        status: 200,
        body: { number: 9, state: 'open', merged: false, mergeable: true, html_url: 'x' },
      },
    })
    const result = await monitorPRs({
      token: 'tok',
      store,
      notify: vi.fn(),
      republish: vi.fn(),
    })
    expect(result.checked).toBe(1)
    expect(result.completed).toBe(0)
    expect(result.failed).toBe(0)
    const active = backing.get('queue') as QueueEntry[]
    expect(active[0]?.status).toBe('running')
  })

  it('skips terminal entries (done/failed/cancelled)', async () => {
    const { store } = makeStore([
      entry({ id: 'a', status: 'done' }),
      entry({ id: 'b', status: 'failed' }),
      entry({ id: 'c', status: 'cancelled' }),
    ])
    const result = await monitorPRs({
      token: 'tok',
      store,
      notify: vi.fn(),
      republish: vi.fn(),
    })
    expect(result.checked).toBe(0)
  })

  it('PR2: caches PR fetch when multiple entries share same PR url', async () => {
    const { store } = makeStore([
      entry({ id: 'a', status: 'running', prUrl: 'https://github.com/o/r/pull/11' }),
      entry({ id: 'b', status: 'running', prUrl: 'https://github.com/o/r/pull/11' }),
    ])
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ number: 11, state: 'open', merged: false, mergeable: true, html_url: 'x' }),
          { status: 200 },
        ),
    )
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    const result = await monitorPRs({
      token: 'tok',
      store,
      notify: vi.fn(),
      republish: vi.fn(),
    })
    // Both entries processed but only 1 HTTP call (cached).
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.checked).toBe(2)
    expect(result.completed).toBe(0)
    expect(result.failed).toBe(0)
  })

  it('records fetch errors without crashing', async () => {
    const { store } = makeStore([
      entry({ id: 'err', status: 'running', prUrl: 'https://github.com/o/r/pull/12' }),
    ])
    mockFetch({ '/pulls/12': { ok: false, status: 403, body: { message: 'forbidden' } } })
    const result = await monitorPRs({
      token: 'tok',
      store,
      notify: vi.fn(),
      republish: vi.fn(),
    })
    expect(result.checked).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('o/r#12')
  })
})
