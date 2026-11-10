/**
 * Durable control plane for the issue queue.
 *
 * The plugin owns a small, deterministic scheduler. It is deliberately
 * SEPARATE from the chain engine (`src/chain.ts`): the engine advances
 * one session's workflow chain, the control plane decides WHICH issues run
 * and reserves the worker slots.
 *
 * Why a control plane is needed
 *
 * The OpenFox host has a task board with its own slots, gates and links
 * (`/api/projects/:id/tasks`), but a plugin cannot reach it: it is not
 * part of `PluginContext`, and its service is internal to the server
 * (`setTasksService`). Driving the host's task board from a plugin would
 * require either an upstream API change or the fragile internal import
 * this plugin must not do. So the plugin keeps its OWN durable registry,
 * with the same discipline: exclusive reservation, explicit capacity,
 * idempotent recovery.
 *
 * Guarantees
 *
 *   - EXCLUSIVE RESERVATION. A worker slot is reserved with a lease; a
 *     second scheduler cannot reserve the same issue.
 *   - BOUNDED CAPACITY. At most `maxWorkers` (5 by default) issues run at
 *     once, globally and per repository.
 *   - DURABLE. The whole registry lives in ONE storage key, so the host's
 *     JSON round-trip makes it atomic per write: there is no read-modify-
 *     write across several keys.
 *   - IDEMPOTENT RECOVERY. Every reservation carries a lease; expired
 *     leases are reclaimed on load, so a crashed host does not leak
 *     slots.
 *   - NO LLM. Admission, ordering, reservation and budget accounting are
 *     pure functions over the registry.
 */
export type WorkItemStatus = 'queued' | 'reserved' | 'running' | 'done' | 'failed' | 'blocked' | 'cancelled';
export interface WorkItem {
    /** Stable identity: `<repoKey>#<issueNumber>`. */
    key: string;
    repoKey: string;
    projectId: string;
    issueNumber: number;
    title: string;
    url: string;
    status: WorkItemStatus;
    /** Position in the admission order (lower = earlier). */
    priority: number;
    /** Issue numbers this item depends on. */
    dependsOn: number[];
    /** Session currently handling the item, when reserved/running. */
    sessionId?: string | undefined;
    /** Epoch ms after which the reservation is considered stale. */
    leaseExpiresAt?: number | undefined;
    /** Number of attempts so far. */
    attempt: number;
    /** Cumulative token usage attributed to this item. */
    tokens: TokenUsage;
    /** Free-form failure reason. */
    error?: string | undefined;
    updatedAt: string;
}
export interface TokenUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedPromptTokens: number;
    cacheWriteTokens: number;
    llmCalls: number;
}
export declare const EMPTY_TOKEN_USAGE: TokenUsage;
export interface ControlPlaneState {
    version: number;
    items: Record<string, WorkItem>;
    /** Monotonic counter used to build stable priorities. */
    sequence: number;
    updatedAt: string;
}
export declare function emptyControlPlaneState(): ControlPlaneState;
export interface ControlPlaneOptions {
    /** Maximum simultaneous workers, globally. */
    maxWorkers: number;
    /** Maximum simultaneous workers per repository. */
    maxWorkersPerRepo: number;
    /** Lease duration in ms. */
    leaseMs: number;
    /** Maximum total tokens per issue before it is blocked. 0 = unlimited. */
    maxTokensPerIssue: number;
}
export declare const DEFAULT_CONTROL_PLANE_OPTIONS: ControlPlaneOptions;
export interface AdmissionCandidate {
    repoKey: string;
    projectId: string;
    issueNumber: number;
    title: string;
    url: string;
    dependsOn?: number[];
    labels?: string[];
}
export interface AdmissionResult {
    admitted: WorkItem[];
    /** Candidates already known (same repoKey#issueNumber). */
    duplicates: number;
}
/**
 * Classify an issue the way the admission rules do.
 *
 * `bug` issues come first, then features, then docs, then everything else.
 * Within a class, the insertion order decides (FIFO).
 */
export declare function classifyLabels(labels: string[]): 'bug' | 'feature' | 'docs' | 'other';
/**
 * Build the priority of a candidate.
 *
 * The priority is a NUMBER so the queue can be sorted deterministically:
 * lower sorts first. It encodes the class rank and the admission order.
 *
 * The class rank is multiplied by a LARGE base so that the admission
 * sequence (which grows by 1 per item) can never overflow into the class
 * range. The base must stay well above the maximum plausible sequence.
 */
export declare function computePriority(labels: string[], sequence: number): number;
/**
 * Admit candidates into the registry.
 *
 * Idempotent: an item already present is never re-admitted, and the
 * priority of an existing item is never rewritten (so a running item is
 * not re-prioritised under it).
 */
export declare function admit(state: ControlPlaneState, candidates: AdmissionCandidate[], options?: {
    now?: number;
}): AdmissionResult;
/**
 * Reclaim expired leases.
 *
 * A reservation whose lease expired (the host crashed, the session died)
 * is BLOCKED, not silently re-queued.
 *
 * The distinction matters: the host session may STILL be running (the
 * plugin lost track of it, but the host did not). Re-queueing the issue
 * would let a second session start for the same issue while the first one
 * is still working on it — a duplicate run, two agents editing the same
 * code. Blocking keeps the issue visible and requires an operator to
 * confirm the host session is really gone before it runs again.
 */
export declare function reclaimExpiredLeases(state: ControlPlaneState, options?: {
    now?: number;
}): WorkItem[];
/**
 * An item can run only when every dependency is DONE.
 *
 * A dependency that is unknown (never admitted) leaves the item BLOCKED:
 * the plugin must not start work whose prerequisite is missing.
 */
export declare function dependencyState(state: ControlPlaneState, item: WorkItem): {
    satisfied: boolean;
    missing: number[];
    blocked: number[];
};
export interface ReservationResult {
    reserved: WorkItem[];
    /** Items that could not be reserved, with the reason. */
    skipped: Array<{
        key: string;
        reason: string;
    }>;
}
/**
 * Reserve worker slots.
 *
 * The scheduler is deterministic: items are considered in priority order,
 * and the FIRST item that can be reserved takes the first free slot. The
 * capacity limits are global and per repository.
 */
export declare function reserve(state: ControlPlaneState, options: ControlPlaneOptions & {
    now?: number;
}): ReservationResult;
/** Attach a session to a reserved item and mark it running. */
export declare function markRunning(state: ControlPlaneState, key: string, sessionId: string, options?: {
    now?: number;
}): WorkItem | null;
/** Mark an item as finished (or failed / cancelled). */
export declare function completeItem(state: ControlPlaneState, key: string, status: 'done' | 'failed' | 'cancelled' | 'blocked', options?: {
    now?: number;
    error?: string;
}): WorkItem | null;
/**
 * Attribute token usage to the item handled by a session.
 *
 * The data comes from the host's `llm.completed` hook, which reports
 * prompt/completion/total tokens plus the CACHED prompt tokens and the
 * cache-write tokens. Tracking the cache counters is what makes the
 * "cost / cache" observation possible.
 */
export declare function recordTokenUsage(state: ControlPlaneState, sessionId: string, usage: Partial<TokenUsage>, options?: {
    now?: number;
    maxTokensPerIssue?: number;
}): WorkItem | null;
export interface ControlPlaneMetrics {
    total: number;
    queued: number;
    reserved: number;
    running: number;
    done: number;
    failed: number;
    blocked: number;
    cancelled: number;
    /** Workers in use right now. */
    activeWorkers: number;
    maxWorkers: number;
    /** Total tokens across all items. */
    totalTokens: number;
    /** Cached prompt tokens across all items. */
    cachedPromptTokens: number;
    /** Cache hit ratio over the whole registry (0..1). */
    cacheHitRatio: number;
    /** Average tokens per finished item. */
    avgTokensPerItem: number;
    /** Per-issue token usage, for the UI. */
    perItem: Array<{
        key: string;
        totalTokens: number;
        cachedPromptTokens: number;
        llmCalls: number;
    }>;
}
export declare function computeControlPlaneMetrics(state: ControlPlaneState, options?: {
    maxWorkers?: number;
}): ControlPlaneMetrics;
/**
 * Parse a stored registry, tolerating corruption.
 *
 * The host's storage is JSON; a partially written or hand-edited value
 * must not crash the plugin. An unusable payload yields an empty registry.
 */
export declare function parseControlPlaneState(raw: unknown): ControlPlaneState;
//# sourceMappingURL=control-plane.d.ts.map