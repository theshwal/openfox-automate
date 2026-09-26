/**
 * Queue state store.
 *
 * Persists in context.storage under:
 *   "queue": QueueEntry[]              (active entries)
 *   "history": QueueEntry[]            (terminated entries)
 *
 * The plugin only reads/writes via the storage passed at construction.
 */
import type { QueueEntry, QueueStatus } from './types.js';
export declare function canTransition(from: QueueStatus, to: QueueStatus): boolean;
export declare function assertTransition(from: QueueStatus, to: QueueStatus): void;
export declare function dedupKey(repoKey: string, issueNumber: number): string;
export interface QueueStorage {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
}
export declare class QueueStore {
    private readonly storage;
    constructor(storage: QueueStorage);
    loadActive(): Promise<QueueEntry[]>;
    loadHistory(): Promise<QueueEntry[]>;
    saveActive(entries: QueueEntry[]): Promise<void>;
    saveHistory(entries: QueueEntry[]): Promise<void>;
    addNew(candidates: QueueEntry[]): Promise<{
        added: QueueEntry[];
        skipped: number;
    }>;
    replace(entries: QueueEntry[]): Promise<void>;
    findById(id: string): Promise<QueueEntry | undefined>;
    update(entry: QueueEntry): Promise<QueueEntry>;
    transitionTo(id: string, next: QueueStatus, patch?: Partial<QueueEntry>): Promise<QueueEntry>;
    remove(id: string): Promise<void>;
    pruneHistory(retention: number): Promise<void>;
}
export declare function isTerminated(status: QueueStatus): boolean;
export declare function newEntryId(): string;
//# sourceMappingURL=queue.d.ts.map