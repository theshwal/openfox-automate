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
}
export declare function applyExecutionEvent(stack: ExecutionStep[], currentIndex: number, event: {
    status: 'pending' | 'running' | 'done' | 'blocked';
}): ChainOutcome;
export declare function startChain(entry: QueueEntry, driver: LaunchDriver, options: {
    sessionId: string;
}): ExecutionStep[];
//# sourceMappingURL=chain.d.ts.map