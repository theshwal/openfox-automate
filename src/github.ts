/**
 * GitHub REST API client — native fetch, no SDK.
 *
 * Endpoints used:
 * - GET   /user                                       (token validation)
 * - GET   /repos/{owner}/{repo}/issues?state=open     (scan, paginated)
 * - GET   /repos/{owner}/{repo}/issues/{n}            (single fetch)
 * - GET   /repos/{owner}/{repo}/issues/{n}/comments   (optional)
 * - GET   /repos/{owner}/{repo}/pulls/{n}             (PR monitor)
 * - POST  /repos/{owner}/{repo}/issues/{n}/comments   (optional)
 * - POST  /repos/{owner}/{repo}/issues/{n}/labels     (optional)
 * - DELETE /repos/{owner}/{repo}/issues/{n}/labels/{name} (optional)
 * - PATCH /repos/{owner}/{repo}/issues/{n}            (optional close)
 * - POST  /repos/{owner}/{repo}/issues/{n}/assignees  (optional)
 */

export interface GitHubIssue {
  number: number
  title: string
  body: string | null
  html_url: string
  state: 'open' | 'closed'
  labels: Array<{ name: string } | string>
  created_at: string
  updated_at: string
  user: { login: string } | null
  pull_request?: unknown
}

export interface GitHubComment {
  id: number
  user: { login: string } | null
  body: string
  created_at: string
}

export interface GitHubPullRequest {
  number: number
  state: 'open' | 'closed'
  merged: boolean
  mergeable: boolean | null
  html_url: string
}

export interface RateLimitInfo {
  remaining: number
  resetAt: Date | null
}

export interface FetchResult<T> {
  ok: boolean
  status: number
  data?: T | undefined
  error?: string | undefined
  rateLimit: RateLimitInfo
}

const GH_API = 'https://api.github.com'

function parseRateLimit(headers: Headers): RateLimitInfo {
  const remaining = Number(headers.get('x-ratelimit-remaining') ?? '0')
  const resetEpoch = Number(headers.get('x-ratelimit-reset') ?? '0')
  const resetAt = resetEpoch > 0 ? new Date(resetEpoch * 1000) : null
  return { remaining, resetAt }
}

async function ghFetch<T>(token: string, url: string, init?: RequestInit): Promise<FetchResult<T>> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'openfox-automate/0.1.0',
      ...(init?.headers ?? {}),
    },
  })
  const rateLimit = parseRateLimit(res.headers)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, status: res.status, error: text || res.statusText, rateLimit }
  }
  const data = (await res.json()) as T
  return { ok: true, status: res.status, data, rateLimit }
}

export async function validateToken(token: string): Promise<{ valid: boolean; rateLimit: RateLimitInfo }> {
  const res = await ghFetch<{ login: string }>(token, `${GH_API}/user`)
  return { valid: res.ok, rateLimit: res.rateLimit }
}

export async function listOpenIssues(
  token: string,
  owner: string,
  repo: string,
  opts: { perPage?: number; page?: number } = {},
): Promise<FetchResult<GitHubIssue[]>> {
  const perPage = opts.perPage ?? 100
  const page = opts.page ?? 1
  return ghFetch<GitHubIssue[]>(
    token,
    `${GH_API}/repos/${owner}/${repo}/issues?state=open&per_page=${perPage}&page=${page}`,
  )
}

export async function fetchAllOpenIssues(
  token: string,
  owner: string,
  repo: string,
  perPage = 100,
): Promise<FetchResult<GitHubIssue[]>> {
  const collected: GitHubIssue[] = []
  let page = 1
  let lastRateLimit: RateLimitInfo = { remaining: 0, resetAt: null }
  while (true) {
    const res = await listOpenIssues(token, owner, repo, { perPage, page })
    lastRateLimit = res.rateLimit
    if (!res.ok) return { ok: false, status: res.status, error: res.error, rateLimit: res.rateLimit }
    if (!res.data || res.data.length === 0) break
    collected.push(...res.data)
    if (res.data.length < perPage) break
    page += 1
  }
  return { ok: true, status: 200, data: collected, rateLimit: lastRateLimit }
}

export async function getIssue(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<FetchResult<GitHubIssue>> {
  return ghFetch<GitHubIssue>(token, `${GH_API}/repos/${owner}/${repo}/issues/${issueNumber}`)
}

export async function listIssueComments(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<FetchResult<GitHubComment[]>> {
  return ghFetch<GitHubComment[]>(token, `${GH_API}/repos/${owner}/${repo}/issues/${issueNumber}/comments`)
}

export async function getPullRequest(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<FetchResult<GitHubPullRequest>> {
  return ghFetch<GitHubPullRequest>(token, `${GH_API}/repos/${owner}/${repo}/pulls/${prNumber}`)
}

export async function createIssueComment(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<FetchResult<{ html_url: string }>> {
  return ghFetch<{ html_url: string }>(
    token,
    `${GH_API}/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    },
  )
}

export async function addIssueLabel(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  label: string,
): Promise<FetchResult<unknown>> {
  return ghFetch<unknown>(token, `${GH_API}/repos/${owner}/${repo}/issues/${issueNumber}/labels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ labels: [label] }),
  })
}

export async function removeIssueLabel(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  label: string,
): Promise<FetchResult<unknown>> {
  return ghFetch<unknown>(
    token,
    `${GH_API}/repos/${owner}/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
    { method: 'DELETE' },
  )
}

export async function setIssueState(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  state: 'open' | 'closed',
): Promise<FetchResult<GitHubIssue>> {
  return ghFetch<GitHubIssue>(token, `${GH_API}/repos/${owner}/${repo}/issues/${issueNumber}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state }),
  })
}

export async function assignIssue(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  assignees: string[],
): Promise<FetchResult<GitHubIssue>> {
  return ghFetch<GitHubIssue>(token, `${GH_API}/repos/${owner}/${repo}/issues/${issueNumber}/assignees`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignees }),
  })
}

export function issueHasIgnoredLabel(issue: GitHubIssue, ignoreLabels: string[]): boolean {
  if (ignoreLabels.length === 0) return false
  const names = issue.labels.map((l) => (typeof l === 'string' ? l : l.name)).map((n) => n.toLowerCase())
  return names.some((n) => ignoreLabels.includes(n))
}

export function extractLabels(issue: GitHubIssue): string[] {
  return issue.labels.map((l) => (typeof l === 'string' ? l : l.name))
}

export function isPullRequest(issue: GitHubIssue): boolean {
  return issue.pull_request !== undefined && issue.pull_request !== null
}
