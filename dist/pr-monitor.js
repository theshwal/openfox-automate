/**
 * PR monitor — periodic polling of opened PR URLs.
 *
 * Implements PR2 / PR3 / PR4:
 *  - PR2: for each queue entry with a captured `prUrl`, fetch the PR
 *    state via `getPullRequest` every `scan.refreshMinutes`.
 *  - PR3: when `mergeable=false` AND `state=open`, mark the entry as
 *    `failed: pr_conflicts`, emit a warning notification with a `Rebuild`
 *    action that calls `reprocess({queueId})`.
 *  - PR4: when `merged=true`, mark the entry as `done` even if the formal
 *    workflow chain did not reach `$done` (covers `Delivery v2` ending
 *    without `step_done()`).
 *
 * Cached within a single tick to avoid duplicate fetches when multiple
 * entries reference the same PR.
 */
import { getPullRequest } from './github.js';
import { completeItem } from './control-plane.js';
import { syncQueueStatus } from './state-ownership.js';
import { RPC_NAMESPACE } from './constants.js';
/**
 * Move an entry to a terminal status, through the control plane.
 *
 * The control plane is the authority: it is updated FIRST, and the legacy
 * queue entry is then written from it. Writing the legacy entry alone
 * (the previous behaviour) left the two views disagreeing — the control
 * plane still said 'running' while the entry said 'done', so the issue
 * could never be scheduled again.
 */
async function transitionThroughControlPlane(deps, entry, status, error) {
    if (!deps.controlPlane) {
        await deps.store.transitionTo(entry.id, status, {
            finishedAt: new Date().toISOString(),
            ...(error ? { error } : {}),
        });
        return;
    }
    const key = `${entry.repoKey}#${entry.issueNumber}`;
    await deps.controlPlane.mutate((state) => {
        if (!state.items[key]) {
            state.items[key] = {
                key,
                repoKey: entry.repoKey,
                projectId: '',
                issueNumber: entry.issueNumber,
                title: '',
                url: '',
                status: 'queued',
                priority: 0,
                dependsOn: [],
                attempt: 0,
                tokens: {
                    promptTokens: 0,
                    completionTokens: 0,
                    totalTokens: 0,
                    cachedPromptTokens: 0,
                    cacheWriteTokens: 0,
                    llmCalls: 0,
                },
                updatedAt: new Date().toISOString(),
            };
        }
        completeItem(state, key, status, error ? { error } : {});
    });
    const item = await deps.controlPlane.mutate((state) => state.items[key]);
    const patched = syncQueueStatus(entry, item);
    await deps.store.transitionTo(entry.id, patched.status, {
        finishedAt: new Date().toISOString(),
        ...(patched.error ? { error: patched.error } : {}),
    });
}
export async function monitorPRs(deps) {
    const result = { checked: 0, failed: 0, completed: 0, errors: [], rateLimit: null };
    const signal = deps.signal;
    const isLive = () => !signal?.aborted;
    const active = await deps.store.loadActive();
    if (!isLive())
        return result;
    const withPR = active.filter((e) => e.prUrl && e.status !== 'done' && e.status !== 'failed' && e.status !== 'cancelled');
    if (withPR.length === 0)
        return result;
    const cache = new Map();
    for (const entry of withPR) {
        if (!isLive()) {
            result.errors.push('aborted: monitorPRs stopped mid-loop');
            break;
        }
        const prUrl = entry.prUrl;
        const m = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
        if (!m)
            continue;
        const [, owner, repo, num] = m;
        if (!owner || !repo || !num)
            continue;
        const cacheKey = `${owner}/${repo}#${num}`;
        let cached = cache.get(cacheKey);
        if (!cached) {
            try {
                const res = await getPullRequest(deps.token, owner, repo, Number(num), signal);
                if (!isLive()) {
                    result.errors.push(`aborted: ${cacheKey} fetch aborted`);
                    break;
                }
                if (res.error === 'aborted') {
                    result.errors.push(`aborted: ${cacheKey}`);
                    break;
                }
                if (!res.ok || !res.data) {
                    result.errors.push(`${cacheKey}: ${res.error ?? res.status}`);
                    continue;
                }
                cached = { pr: res.data, rateLimit: res.rateLimit };
                cache.set(cacheKey, cached);
                result.rateLimit = res.rateLimit;
            }
            catch (err) {
                result.errors.push(`${cacheKey}: ${err instanceof Error ? err.message : String(err)}`);
                continue;
            }
        }
        result.checked += 1;
        const pr = cached.pr;
        if (pr.merged) {
            await transitionThroughControlPlane(deps, entry, 'done');
            result.completed += 1;
            deps.notify({
                title: { en: 'PR merged', fr: 'PR fusionnée' },
                body: {
                    en: `${entry.repoKey}#${entry.issueNumber} — PR merged (chain treated as done)`,
                    fr: `${entry.repoKey}#${entry.issueNumber} — PR fusionnée (chaîne traitée comme terminée)`,
                },
                level: 'success',
            });
            continue;
        }
        if (pr.state === 'open' && pr.mergeable === false) {
            await transitionThroughControlPlane(deps, entry, 'failed', 'pr_conflicts');
            result.failed += 1;
            deps.notify({
                title: { en: 'PR has conflicts', fr: 'PR en conflit' },
                body: {
                    en: `${entry.repoKey}#${entry.issueNumber} — merge conflicts detected on ${pr.html_url}`,
                    fr: `${entry.repoKey}#${entry.issueNumber} — conflits de merge détectés sur ${pr.html_url}`,
                },
                level: 'warning',
                actions: [
                    {
                        label: { en: 'Rebuild', fr: 'Reconstruire' },
                        onActivate: { kind: 'rpc', method: `${RPC_NAMESPACE}reprocess`, params: { queueId: entry.id } },
                    },
                ],
            });
        }
    }
    if (!isLive()) {
        result.errors.push('aborted: monitorPRs stopped before republish');
        return result;
    }
    deps.republish();
    return result;
}
export function hasOpenPRs(entries) {
    return entries.some((e) => e.prUrl && e.status !== 'done' && e.status !== 'failed' && e.status !== 'cancelled');
}
void {};
//# sourceMappingURL=pr-monitor.js.map