/**
 * GitHub post-process — optional writes after a chain completes.
 *
 * All toggles (`post.closeOnSuccess`, `post.assignOnSuccess`,
 * `post.commentTemplate`) default to false/empty; Delivery v2 handles
 * the canonical interaction. The plugin only acts when explicitly
 * configured to.
 */
import { addIssueLabel, assignIssue, createIssueComment, removeIssueLabel, setIssueState } from './github.js';
export function renderTemplate(template, ctx) {
    return template
        .replace(/\{\{title\}\}/g, ctx.title)
        .replace(/\{\{summary\}\}/g, ctx.summary)
        .replace(/\{\{sessionUrl\}\}/g, ctx.sessionUrl)
        .replace(/\{\{prUrl\}\}/g, ctx.prUrl);
}
export async function postProcess(entry, settings, ctx, deps) {
    const result = {
        commented: false,
        labeled: { added: [], removed: [] },
        closed: false,
        assigned: [],
        errors: [],
    };
    const signal = deps.signal;
    const isLive = () => !signal?.aborted;
    const hasAnyToggle = Boolean(settings['post.commentTemplate']) ||
        Boolean(settings['post.closeOnSuccess']) ||
        Boolean(settings['post.assignOnSuccess']);
    if (!deps.token || !hasAnyToggle) {
        return result;
    }
    if (!isLive()) {
        result.errors.push('aborted: postProcess stopped before run');
        return result;
    }
    const template = settings['post.commentTemplate'];
    if (template && template.trim().length > 0) {
        if (!isLive()) {
            result.errors.push('aborted: postProcess stopped before comment');
            return result;
        }
        try {
            const body = renderTemplate(template, {
                title: entry.title,
                summary: ctx.summary,
                sessionUrl: ctx.sessionUrl,
                prUrl: ctx.prUrl,
            });
            const r = await createIssueComment(deps.token, deps.owner, deps.repo, entry.issueNumber, body, signal);
            if (r.ok && r.data)
                result.commented = true;
            else
                result.errors.push(`comment: ${r.error ?? r.status}`);
        }
        catch (e) {
            result.errors.push(`comment exception: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    if (isLive()) {
        try {
            const added = await addIssueLabel(deps.token, deps.owner, deps.repo, entry.issueNumber, 'agent-done', signal);
            if (added.ok)
                result.labeled.added.push('agent-done');
            else
                result.errors.push(`label add: ${added.error ?? added.status}`);
        }
        catch (e) {
            result.errors.push(`label add exception: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    if (isLive()) {
        try {
            const removed = await removeIssueLabel(deps.token, deps.owner, deps.repo, entry.issueNumber, 'agent-ready', signal);
            if (removed.ok || removed.status === 404)
                result.labeled.removed.push('agent-ready');
            else
                result.errors.push(`label remove: ${removed.error ?? removed.status}`);
        }
        catch (e) {
            result.errors.push(`label remove exception: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    if (settings['post.closeOnSuccess'] && isLive()) {
        try {
            const r = await setIssueState(deps.token, deps.owner, deps.repo, entry.issueNumber, 'closed', signal);
            if (r.ok)
                result.closed = true;
            else
                result.errors.push(`close: ${r.error ?? r.status}`);
        }
        catch (e) {
            result.errors.push(`close exception: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    if (settings['post.assignOnSuccess'] && ctx.me && isLive()) {
        try {
            const r = await assignIssue(deps.token, deps.owner, deps.repo, entry.issueNumber, [ctx.me], signal);
            if (r.ok)
                result.assigned.push(ctx.me);
            else
                result.errors.push(`assign: ${r.error ?? r.status}`);
        }
        catch (e) {
            result.errors.push(`assign exception: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    return result;
}
export async function fetchAuthenticatedLogin(token, signal) {
    if (!token)
        return null;
    try {
        const res = await fetch('https://api.github.com/user', {
            ...(signal ? { signal } : {}),
            headers: {
                Accept: 'application/vnd.github+json',
                Authorization: `Bearer ${token}`,
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'openfox-automate/0.1.0',
            },
        });
        if (!res.ok)
            return null;
        const body = (await res.json());
        return body.login ?? null;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=postprocess.js.map