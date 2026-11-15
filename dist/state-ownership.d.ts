/**
 * Source of truth for the scheduling state.
 *
 * PROBLEM
 *
 * The plugin historically kept the scheduling state in the legacy queue
 * (`QueueEntry.status`, `sessionId`, `error`, `dependsOn`) AND the
 * control plane kept its own copy (`WorkItem.status`, `sessionId`,
 * `error`, `dependsOn`). Two writers, two reads: the two could disagree,
 * and a disagreement meant either a duplicate session or an issue stuck
 * in a state nobody owned.
 *
 * RESOLUTION
 *
 * There is exactly ONE authority for the scheduling state:
 *
 *   - the CONTROL PLANE (`WorkItem`) owns the lifecycle of an issue:
 *     queued → reserved → running → done / failed / blocked / cancelled,
 *     the reservation, the lease, the dependency edges and the token
 *     budget;
 *   - the LEGACY QUEUE (`QueueEntry`) owns only what the CHAIN ENGINE
 *     needs: the execution stack, the timestamps and the GitHub artefacts
 *     (PR URL, comment URL). Its `status` is a DERIVED mirror of the
 *     control-plane status, written by `syncQueueStatus`.
 *
 * The mapping is total and explicit, so the two views cannot drift
 * silently: `deriveQueueStatus` is the only function that decides what the
 * legacy status must be for a given control-plane status.
 */
import type { QueueEntry, QueueStatus } from './types.js';
import type { WorkItem } from './control-plane.js';
/**
 * Map a control-plane status onto the legacy queue status.
 *
 * `reserved` is an internal scheduling state with no legacy equivalent:
 * from the chain engine's point of view the issue is queued until a
 * session exists.
 */
export declare function deriveQueueStatus(item: WorkItem | undefined): QueueStatus;
/**
 * Write the control-plane status onto a legacy queue entry.
 *
 * The entry is returned with the derived status and the authoritative
 * error message. The execution stack, the timestamps and the GitHub
 * artefacts are left untouched: they belong to the chain engine.
 */
export declare function syncQueueStatus(entry: QueueEntry, item: WorkItem | undefined): QueueEntry;
/**
 * Detect a divergence between the two views.
 *
 * A divergence is NOT a crash: it is reported so the caller can repair
 * it from the control plane, which is the authority. This exists to make
 * a silent drift observable in the tests instead of invisible in
 * production.
 */
export declare function findDivergence(entry: QueueEntry, item: WorkItem | undefined): string | null;
//# sourceMappingURL=state-ownership.d.ts.map