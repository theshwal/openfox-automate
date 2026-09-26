/**
 * Metrics computation — lazy, no background timer.
 *
 * Pulls history from the QueueStore and computes:
 *  - issues today / this week / total
 *  - average chain duration
 *  - success rate
 *  - current throughput (issues/hour over the last 24h)
 *  - most-failing workflow
 *  - 7-day sparkline (done vs failed per day)
 */
import type { QueueEntry } from './types.js';
export interface MetricsReport {
    total: number;
    today: number;
    thisWeek: number;
    successRate: number;
    avgDurationMs: number | null;
    throughputPerHour: number;
    mostFailingWorkflow: string | null;
    sparkline: Array<{
        day: string;
        done: number;
        failed: number;
    }>;
}
export declare function computeMetrics(history: QueueEntry[]): MetricsReport;
//# sourceMappingURL=metrics.d.ts.map