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
export async function monitorPRs(deps) {
    const result = { checked: 0, failed: 0, completed: 0, errors: [], rateLimit: null };
    const active = await deps.store.loadActive();
    const withPR = active.filter((e) => e.prUrl && e.status !== 'done' && e.status !== 'failed' && e.status !== 'cancelled');
    if (withPR.length === 0)
        return result;
    const cache = new Map();
    for (const entry of withPR) {
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
                const res = await getPullRequest(deps.token, owner, repo, Number(num));
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
            await deps.store.transitionTo(entry.id, 'done', {
                finishedAt: new Date().toISOString(),
            });
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
            await deps.store.transitionTo(entry.id, 'failed', {
                finishedAt: new Date().toISOString(),
                error: 'pr_conflicts',
            });
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
                        onActivate: { kind: 'rpc', method: 'reprocess', params: { queueId: entry.id } },
                    },
                ],
            });
        }
    }
    deps.republish();
    return result;
}
export function hasOpenPRs(entries) {
    return entries.some((e) => e.prUrl && e.status !== 'done' && e.status !== 'failed' && e.status !== 'cancelled');
}
void {};
//# sourceMappingURL=pr-monitor.js.map