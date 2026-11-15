/**
 * Adapters between the OpenFox host event payloads and the plugin's
 * internal vocabulary.
 *
 * HOST SHAPES (verified against `openfox@2.0.160`, see
 * `node_modules/openfox/dist/chunk-2J6OW67H.js` — `handleStoredEvent` /
 * `HookBus.emit` — and `node_modules/openfox/dist/chunk-HW4ZR5QY.js` —
 * `emitToolResult`):
 *
 *   workflow.execution.changed →
 *     {
 *       event: 'workflow.execution.changed',
 *       timestamp: ISO,
 *       sessionId: string,
 *       projectId?: string,
 *       data: {
 *         executionId: string,
 *         workflowId: string,
 *         workflowName?: string,
 *         status: 'running' | 'waiting' | 'completed' | 'cancelled' | 'blocked',
 *         currentStepId?: string,
 *         currentStepName?: string,
 *         pendingChoices?: unknown[]
 *       }
 *     }
 *
 *   tool.completed →
 *     {
 *       event: 'tool.completed',
 *       timestamp: ISO,
 *       sessionId: string,
 *       data: {
 *         messageId: string,
 *         toolCallId: string,
 *         result: { success: boolean, output?: string, error?: string, ... }
 *       }
 *     }
 *
 * The plugin used to read the workflow/tool fields at the ROOT of the
 * payload, which never matched the host contract: `payload.status` and
 * `payload.executionId` are `undefined`, and the tool output lives in
 * `payload.data.result.output`. These adapters read the real shape, with a
 * fallback to the flat shape so older/alternate hosts keep working.
 */
/** Status vocabulary emitted by the OpenFox host. */
export type HostWorkflowStatus = 'running' | 'waiting' | 'completed' | 'cancelled' | 'blocked';
/**
 * Status vocabulary used inside the plugin. `completed` is normalised to
 * `done` (the engine's own spelling) and `cancelled` is kept distinct from
 * `blocked` so the engine can treat it as terminal WITHOUT triggering its
 * retry-once path.
 */
export type InternalWorkflowStatus = 'running' | 'waiting' | 'done' | 'blocked' | 'cancelled';
export interface NormalizedWorkflowEvent {
    sessionId: string;
    executionId: string;
    workflowId: string;
    status: InternalWorkflowStatus;
}
/** Read the session id carried by any host event payload. */
export declare function readSessionId(payload: unknown): string;
/**
 * Map a host status to the plugin's internal status.
 * Returns `null` for an unknown status so the caller can ignore the event.
 */
export declare function mapHostWorkflowStatus(raw: unknown): InternalWorkflowStatus | null;
/**
 * Normalise a `workflow.execution.changed` payload.
 *
 * Returns `null` — meaning "ignore this event, launch nothing" — when the
 * payload is incomplete: no session, no execution id, or no usable status.
 */
export declare function normalizeWorkflowExecutionPayload(payload: unknown): NormalizedWorkflowEvent | null;
/**
 * Extract the textual output carried by a `tool.completed` payload.
 *
 * The host wraps the tool result in `data.result` (a ToolResult whose text
 * lives in `output`). The flat `{ sessionId, output }` shape is still
 * accepted for backward compatibility.
 */
export declare function extractToolOutputText(payload: unknown): string | null;
//# sourceMappingURL=host-events.d.ts.map