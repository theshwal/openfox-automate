/**
 * Workflow chain orchestrator.
 *
 * Given a session + a chain of workflow IDs, this module:
 *  1. Launches workflow 1 of the chain with the issue context as params.
 *  2. Listens for `workflow.execution.changed` events.
 *  3. On `done`: advances to the next workflow in the chain.
 *  4. On `blocked`: retries once, then pauses + notifies user.
 *  5. On full chain completion: marks the queue entry `done`.
 *
 * The actual `launchWorkflowRun` call is delegated to the host via the
 * `LaunchDriver` interface — in production this is the OpenFox runtime
 * resolved by `resolve-openfox.ts`, in tests it is an injected fake.
 */
import type { ExecutionStep, QueueEntry } from './types.js';
export interface ChainContext {
    entry: QueueEntry;
    chain: string[];
    currentStepIndex: number;
}
export interface LaunchDriver {
    launch(params: LaunchParams): void;
    /**
     * Called when the host reports the session it actually bound to the run.
     *
     * The host seeds a NEW session when the one it was given already has
     * messages, so the plugin cannot assume its own session is reused: it
     * must follow the reported id, or the host's events are ignored and the
     * chain stalls after its first step.
     *
     * The SAME rule applies to EVERY step of the chain, not only the first
     * one: by the second step the session already has messages, so the host
     * necessarily seeds a new one.
     */
    onSessionBound?(sessionId: string, workflowId: string): void;
    /**
     * Called when the host reports the TASK it created for the run.
     *
     * The host only frees a worker slot when its task leaves "in_progress",
     * so every task the plugin creates must be closed — including the ones
     * created for the INTERMEDIATE steps of a chain.
     */
    onTaskBound?(taskId: string, workflowId: string): void;
}
export interface LaunchParams {
    sessionId: string;
    workflowId: string;
    content: string;
    params: Record<string, string>;
    /** The host project the workflow belongs to (needed by the task-board launch). */
    projectId?: string | undefined;
}
export declare function buildIssueContext(entry: QueueEntry): string;
export declare function buildIssueParams(entry: QueueEntry): Record<string, string>;
export declare function initExecutionStack(chain: string[]): ExecutionStep[];
export interface ChainOutcome {
    nextStepIndex: number;
    finished: boolean;
    blocked: boolean;
    waiting: boolean;
    /** The host cancelled the execution: terminal, and NOT a retryable block. */
    cancelled: boolean;
}
/**
 * Status vocabulary of the chain engine.
 *
 * `done` and `cancelled` come from the host adapter
 * (`src/host-events.ts`): the OpenFox host emits `completed` (normalised to
 * `done`) and `cancelled` (kept distinct so it is terminal without
 * triggering the retry-once path).
 */
export type ChainEventStatus = 'pending' | 'running' | 'done' | 'blocked' | 'waiting' | 'cancelled';
export declare function applyExecutionEvent(stack: ExecutionStep[], currentIndex: number, event: {
    status: ChainEventStatus;
}): ChainOutcome;
export declare function startChain(entry: QueueEntry, driver: LaunchDriver, options: {
    sessionId: string;
}): ExecutionStep[];
/**
 * Event payload for a workflow execution change.
 *
 * `executionId` is REQUIRED by the OpenFox host event type. The plugin
 * refuses to process events that lack it (logged + ignored) to avoid
 * the previous ambiguity where retry events shared their dedup key with
 * the original block event under the (sessionId, workflowId, status)
 * fallback.
 */
export interface WorkflowExecutionChange {
    sessionId?: string | undefined;
    workflowId?: string | undefined;
    executionId?: string | undefined;
    status?: ChainEventStatus | undefined;
}
export interface ProcessLaunch {
    sessionId: string;
    workflowId: string;
    content: string;
    params: Record<string, string>;
    /** The host project the workflow belongs to (needed by the task-board launch). */
    projectId?: string | undefined;
}
/**
 * Pure orchestration outcome from processing a workflow.execution.changed
 * event. The caller (the hook) applies side effects (transitions, picks
 * next, posts process). The function itself only mutates the entry's
 * `executionStack` in place via `applyExecutionEvent`.
 */
export interface ProcessWorkflowOutcome {
    /** Workflows to launch (chain advance or retry). */
    launches: ProcessLaunch[];
    /** Status the entry should be transitioned to (if any). */
    transitionTo?: 'done' | 'blocked' | undefined;
    /** Reason for `blocked` transition. */
    blockedReason?: string | undefined;
    /** The dedup key used (or null if no executionId was provided). */
    dedupKey: string | null;
    /** Whether the event was deduplicated. */
    deduplicated: boolean;
    /** Whether the chain is finished (last workflow done or final block). */
    finished?: boolean;
    /** Whether the workflow is paused waiting for user input. */
    waiting?: boolean;
}
export interface ProcessDeps {
    /** Mutable set tracking applied (executionId, status) pairs. */
    appliedExecutionEvents: Set<string>;
    /** Optional logger for warnings. */
    log?: (msg: string) => void;
    buildIssueContext: (entry: QueueEntry) => string;
    buildIssueParams: (entry: QueueEntry) => Record<string, string>;
}
/**
 * Process one workflow.execution.changed event against the entry's
 * executionStack. Returns the side-effects the caller should apply
 * (transitions, launches). The function itself only mutates the
 * entry's executionStack via applyExecutionEvent.
 *
 * Idempotency: keyed by `${executionId}:${status}`. Without executionId,
 * the event is rejected (warning + no-op) so we never confuse two
 * distinct retry attempts with the same status.
 */
export declare function processWorkflowEvent(entry: QueueEntry, event: WorkflowExecutionChange, deps: ProcessDeps): ProcessWorkflowOutcome;
/**
 * Remove all dedup keys for a given sessionId. Call this when an entry
 * transitions to a terminal status (done/blocked/cancelled) so the
 * appliedExecutionEvents Set doesn't grow unbounded over a long-running
 * OpenFox instance.
 */
export declare function purgeAppliedExecutionEvents(set: Set<string>, predicate: (key: string) => boolean): void;
//# sourceMappingURL=chain.d.ts.map