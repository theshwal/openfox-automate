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
/**
 * Find the entries whose dependency is missing.
 *
 * `satisfiedNumbers` carries the issue numbers that are known to be
 * SATISFIED even when they are not in the active queue — a dependency that
 * already completed lives in the HISTORY, and treating it as missing would
 * re-block its dependents forever.
 */
export declare function findMissingDependencies(entries: QueueEntry[], satisfiedNumbers?: Iterable<number>, knownNumbers?: Iterable<number>): {
    entry: QueueEntry;
    missing: number[];
}[];
//# sourceMappingURL=ordering.d.ts.map