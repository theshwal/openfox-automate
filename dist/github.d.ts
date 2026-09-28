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
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    state: 'open' | 'closed';
    labels: Array<{
        name: string;
    } | string>;
    created_at: string;
    updated_at: string;
    user: {
        login: string;
    } | null;
    pull_request?: unknown;
}
export interface GitHubComment {
    id: number;
    user: {
        login: string;
    } | null;
    body: string;
    created_at: string;
}
export interface GitHubPullRequest {
    number: number;
    state: 'open' | 'closed';
    merged: boolean;
    mergeable: boolean | null;
    html_url: string;
}
export interface RateLimitInfo {
    remaining: number;
    resetAt: Date | null;
}
export interface FetchResult<T> {
    ok: boolean;
    status: number;
    data?: T | undefined;
    error?: string | undefined;
    rateLimit: RateLimitInfo;
}
export declare function validateToken(token: string, signal?: AbortSignal): Promise<{
    valid: boolean;
    rateLimit: RateLimitInfo;
}>;
export declare function listOpenIssues(token: string, owner: string, repo: string, opts?: {
    perPage?: number;
    page?: number;
    signal?: AbortSignal;
}): Promise<FetchResult<GitHubIssue[]>>;
export declare function fetchAllOpenIssues(token: string, owner: string, repo: string, perPageOrOpts?: number | {
    perPage?: number;
    signal?: AbortSignal;
}, maybeSignal?: AbortSignal): Promise<FetchResult<GitHubIssue[]>>;
export declare function getIssue(token: string, owner: string, repo: string, issueNumber: number, signal?: AbortSignal): Promise<FetchResult<GitHubIssue>>;
export declare function listIssueComments(token: string, owner: string, repo: string, issueNumber: number, signal?: AbortSignal): Promise<FetchResult<GitHubComment[]>>;
export declare function getPullRequest(token: string, owner: string, repo: string, prNumber: number, signal?: AbortSignal): Promise<FetchResult<GitHubPullRequest>>;
export declare function createIssueComment(token: string, owner: string, repo: string, issueNumber: number, body: string, signal?: AbortSignal): Promise<FetchResult<{
    html_url: string;
}>>;
export declare function addIssueLabel(token: string, owner: string, repo: string, issueNumber: number, label: string, signal?: AbortSignal): Promise<FetchResult<unknown>>;
export declare function removeIssueLabel(token: string, owner: string, repo: string, issueNumber: number, label: string, signal?: AbortSignal): Promise<FetchResult<unknown>>;
export declare function setIssueState(token: string, owner: string, repo: string, issueNumber: number, state: 'open' | 'closed', signal?: AbortSignal): Promise<FetchResult<GitHubIssue>>;
export declare function assignIssue(token: string, owner: string, repo: string, issueNumber: number, assignees: string[], signal?: AbortSignal): Promise<FetchResult<GitHubIssue>>;
export declare function issueHasIgnoredLabel(issue: GitHubIssue, ignoreLabels: string[]): boolean;
export declare function extractLabels(issue: GitHubIssue): string[];
export declare function isPullRequest(issue: GitHubIssue): boolean;
//# sourceMappingURL=github.d.ts.map