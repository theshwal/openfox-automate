import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  extractLabels,
  issueHasIgnoredLabel,
  isPullRequest,
  listOpenIssues,
  fetchAllOpenIssues,
  validateToken,
  getPullRequest,
  addIssueLabel,
  createIssueComment,
} from '../src/github.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: init.headers ?? { 'Content-Type': 'application/json' },
  })
}

describe('extractLabels / issueHasIgnoredLabel', () => {
  it('extracts string and object labels', () => {
    const labels = extractLabels({
      number: 1,
      title: 't',
      body: '',
      html_url: '',
      state: 'open',
      labels: [{ name: 'bug' }, 'enhancement'],
      created_at: '',
      updated_at: '',
      user: null,
    })
    expect(labels).toEqual(['bug', 'enhancement'])
  })

  it('returns true when any label matches ignore list (case-insensitive)', () => {
    const issue = {
      number: 1,
      title: 't',
      body: '',
      html_url: '',
      state: 'open' as const,
      labels: [{ name: 'WontFix' }],
      created_at: '',
      updated_at: '',
      user: null,
    }
    expect(issueHasIgnoredLabel(issue, ['wontfix'])).toBe(true)
  })

  it('returns false when no label matches', () => {
    const issue = {
      number: 1,
      title: 't',
      body: '',
      html_url: '',
      state: 'open' as const,
      labels: [{ name: 'bug' }],
      created_at: '',
      updated_at: '',
      user: null,
    }
    expect(issueHasIgnoredLabel(issue, ['wontfix'])).toBe(false)
  })

  it('returns false for empty ignore list', () => {
    const issue = {
      number: 1,
      title: 't',
      body: '',
      html_url: '',
      state: 'open' as const,
      labels: [{ name: 'wontfix' }],
      created_at: '',
      updated_at: '',
      user: null,
    }
    expect(issueHasIgnoredLabel(issue, [])).toBe(false)
  })

  it('isPullRequest detects PR-shaped issues', () => {
    expect(
      isPullRequest({
        number: 1,
        title: 't',
        body: '',
        html_url: '',
        state: 'open',
        labels: [],
        created_at: '',
        updated_at: '',
        user: null,
        pull_request: {},
      }),
    ).toBe(true)
    expect(
      isPullRequest({
        number: 1,
        title: 't',
        body: '',
        html_url: '',
        state: 'open',
        labels: [],
        created_at: '',
        updated_at: '',
        user: null,
      }),
    ).toBe(false)
  })
})

describe('GitHub fetch wrappers', () => {
  it('validateToken succeeds with 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ login: 'octo' }, { headers: { 'x-ratelimit-remaining': '5000' } })),
    )
    const res = await validateToken('tok')
    expect(res.valid).toBe(true)
    expect(res.rateLimit.remaining).toBe(5000)
  })

  it('validateToken fails with 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ message: 'bad creds' }, { status: 401 })),
    )
    const res = await validateToken('bad')
    expect(res.valid).toBe(false)
  })

  it('listOpenIssues calls the right URL with per_page', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse([
        {
          number: 1,
          title: 'a',
          body: '',
          html_url: '',
          state: 'open',
          labels: [],
          created_at: '',
          updated_at: '',
          user: null,
        },
      ]),
    )
    vi.stubGlobal('fetch', fetchMock)
    await listOpenIssues('tok', 'org', 'repo', { perPage: 50, page: 2 })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/repos/org/repo/issues'),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer tok' }) }),
    )
    const url = String(fetchMock.mock.calls[0]?.[0] as string)
    expect(url).toContain('per_page=50')
    expect(url).toContain('page=2')
  })

  it('fetchAllOpenIssues paginates until empty', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      number: i + 1,
      title: `t${i}`,
      body: '',
      html_url: '',
      state: 'open' as const,
      labels: [],
      created_at: '',
      updated_at: '',
      user: null,
    }))
    const page2 = [
      {
        number: 200,
        title: 't200',
        body: '',
        html_url: '',
        state: 'open' as const,
        labels: [],
        created_at: '',
        updated_at: '',
        user: null,
      },
    ]
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(page1))
      .mockResolvedValueOnce(jsonResponse(page2))
    vi.stubGlobal('fetch', fetchMock)
    const res = await fetchAllOpenIssues('tok', 'org', 'repo', 100)
    expect(res.ok).toBe(true)
    expect(res.data).toHaveLength(101)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('addIssueLabel POSTs the right payload', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([{ name: 'agent-done' }]))
    vi.stubGlobal('fetch', fetchMock)
    await addIssueLabel('tok', 'org', 'repo', 7, 'agent-done')
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(String(url)).toContain('/issues/7/labels')
    expect((init as RequestInit | undefined)?.method).toBe('POST')
  })

  it('createIssueComment sends the body', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ html_url: 'https://x' }))
    vi.stubGlobal('fetch', fetchMock)
    await createIssueComment('tok', 'org', 'repo', 7, 'hello')
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(String(url)).toContain('/issues/7/comments')
    expect((init as RequestInit | undefined)?.method).toBe('POST')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ body: 'hello' })
  })

  it('getPullRequest hits the pulls endpoint', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ number: 1, state: 'open', merged: false, mergeable: true, html_url: 'https://x' }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await getPullRequest('tok', 'org', 'repo', 5)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/pulls/5')
  })
})
