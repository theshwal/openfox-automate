/**
 * Queue ordering strategies.
 *
 * Three strategies:
 *  - default: no-blockers → bug > enhancement > docs → FIFO (createdAt asc)
 *  - priority-labels: explicit priority labels → FIFO
 *  - strict-deps: topological sort; cycle or missing dep → marked blocked
 */
import type { QueueEntry, OrderingStrategy } from './types.js';
export declare function parseDependencies(text: string, pattern: string): number[];
export declare function orderQueue(entries: QueueEntry[], strategy: OrderingStrategy, depPattern: string): {
    ordered: QueueEntry[];
    cycleEntries: QueueEntry[];
};
export declare function findMissingDependencies(entries: QueueEntry[]): {
    entry: QueueEntry;
    missing: number[];
}[];
//# sourceMappingURL=ordering.d.ts.map