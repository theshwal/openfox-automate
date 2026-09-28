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
import type { QueueEntry } from './types.js';
import { type RateLimitInfo } from './github.js';
import type { QueueStore } from './queue.js';
export interface PRMonitorDeps {
    token: string;
    store: QueueStore;
    notify: (notification: {
        title: {
            en: string;
            fr: string;
        };
        body: {
            en: string;
            fr: string;
        };
        level: 'info' | 'success' | 'warning' | 'error';
        actions?: Array<{
            label: {
                en: string;
                fr: string;
            };
            onActivate: {
                kind: 'rpc';
                method: string;
                params: Record<string, unknown>;
            };
        }>;
    }) => void;
    republish: () => void;
    /** AbortSignal forwarded into GitHub fetches. */
    signal?: AbortSignal;
}
export interface PRMonitorResult {
    checked: number;
    failed: number;
    completed: number;
    errors: string[];
    rateLimit: RateLimitInfo | null;
}
export declare function monitorPRs(deps: PRMonitorDeps): Promise<PRMonitorResult>;
export declare function hasOpenPRs(entries: QueueEntry[]): boolean;
//# sourceMappingURL=pr-monitor.d.ts.map