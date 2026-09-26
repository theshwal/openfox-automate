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
const GH_API = 'https://api.github.com';
function parseRateLimit(headers) {
    const remaining = Number(headers.get('x-ratelimit-remaining') ?? '0');
    const resetEpoch = Number(headers.get('x-ratelimit-reset') ?? '0');
    const resetAt = resetEpoch > 0 ? new Date(resetEpoch * 1000) : null;
    return { remaining, resetAt };
}
async function ghFetch(token, url, init) {
    const res = await fetch(url, {
        ...init,
        headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'openfox-automate/0.1.0',
            ...(init?.headers ?? {}),
        },
    });
    const rateLimit = parseRateLimit(res.headers);
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, status: res.status, error: text || res.statusText, rateLimit };
    }
    const data = (await res.json());
    return { ok: true, status: res.status, data, rateLimit };
}
export async function validateToken(token) {
    const res = await ghFetch(token, `${GH_API}/user`);
    return { valid: res.ok, rateLimit: res.rateLimit };
}
export async function listOpenIssues(token, owner, repo, opts = {}) {
    const perPage = opts.perPage ?? 100;
    const page = opts.page ?? 1;
    return ghFetch(token, `${GH_API}/repos/${owner}/${repo}/issues?state=open&per_page=${perPage}&page=${page}`);
}
export async function fetchAllOpenIssues(token, owner, repo, perPage = 100) {
    const collected = [];
    let page = 1;
    let lastRateLimit = { remaining: 0, resetAt: null };
    while (true) {
        const res = await listOpenIssues(token, owner, repo, { perPage, page });
        lastRateLimit = res.rateLimit;
        if (!res.ok)
            return { ok: false, status: res.status, error: res.error, rateLimit: res.rateLimit };
        if (!res.data || res.data.length === 0)
            break;
        collected.push(...res.data);
        if (res.data.length < perPage)
            break;
        page += 1;
    }
    return { ok: true, status: 200, data: collected, rateLimit: lastRateLimit };
}
export async function getIssue(token, owner, repo, issueNumber) {
    return ghFetch(token, `${GH_API}/repos/${owner}/${repo}/issues/${issueNumber}`);
}
export async function listIssueComments(token, owner, repo, issueNumber) {
    return ghFetch(token, `${GH_API}/repos/${owner}/${repo}/issues/${issueNumber}/comments`);
}
export async function getPullRequest(token, owner, repo, prNumber) {
    return ghFetch(token, `${GH_API}/repos/${owner}/${repo}/pulls/${prNumber}`);
}
export async function createIssueComment(token, owner, repo, issueNumber, body) {
    return ghFetch(token, `${GH_API}/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
    });
}
export async function addIssueLabel(token, owner, repo, issueNumber, label) {
    return ghFetch(token, `${GH_API}/repos/${owner}/${repo}/issues/${issueNumber}/labels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labels: [label] }),
    });
}
export async function removeIssueLabel(token, owner, repo, issueNumber, label) {
    return ghFetch(token, `${GH_API}/repos/${owner}/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`, { method: 'DELETE' });
}
export async function setIssueState(token, owner, repo, issueNumber, state) {
    return ghFetch(token, `${GH_API}/repos/${owner}/${repo}/issues/${issueNumber}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state }),
    });
}
export async function assignIssue(token, owner, repo, issueNumber, assignees) {
    return ghFetch(token, `${GH_API}/repos/${owner}/${repo}/issues/${issueNumber}/assignees`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignees }),
    });
}
export function issueHasIgnoredLabel(issue, ignoreLabels) {
    if (ignoreLabels.length === 0)
        return false;
    const names = issue.labels
        .map((l) => (typeof l === 'string' ? l : l.name))
        .map((n) => n.toLowerCase());
    return names.some((n) => ignoreLabels.includes(n));
}
export function extractLabels(issue) {
    return issue.labels.map((l) => (typeof l === 'string' ? l : l.name));
}
export function isPullRequest(issue) {
    return issue.pull_request !== undefined && issue.pull_request !== null;
}
//# sourceMappingURL=github.js.map