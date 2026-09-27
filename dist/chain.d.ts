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
}
export interface LaunchParams {
    sessionId: string;
    workflowId: string;
    content: string;
    params: Record<string, string>;
}
export declare function buildIssueContext(entry: QueueEntry): string;
export declare function buildIssueParams(entry: QueueEntry): Record<string, string>;
export declare function initExecutionStack(chain: string[]): ExecutionStep[];
export interface ChainOutcome {
    nextStepIndex: number;
    finished: boolean;
    blocked: boolean;
    waiting: boolean;
}
export declare function applyExecutionEvent(stack: ExecutionStep[], currentIndex: number, event: {
    status: 'pending' | 'running' | 'done' | 'blocked' | 'waiting';
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
    status?: 'pending' | 'running' | 'done' | 'blocked' | undefined;
}
export interface ProcessLaunch {
    sessionId: string;
    workflowId: string;
    content: string;
    params: Record<string, string>;
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