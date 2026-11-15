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
export type HostWorkflowStatus = 'running' | 'waiting' | 'completed' | 'cancelled' | 'blocked'

/**
 * Status vocabulary used inside the plugin. `completed` is normalised to
 * `done` (the engine's own spelling) and `cancelled` is kept distinct from
 * `blocked` so the engine can treat it as terminal WITHOUT triggering its
 * retry-once path.
 */
export type InternalWorkflowStatus = 'running' | 'waiting' | 'done' | 'blocked' | 'cancelled'

export interface NormalizedWorkflowEvent {
  sessionId: string
  executionId: string
  workflowId: string
  status: InternalWorkflowStatus
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function asNonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Read the session id carried by any host event payload. */
export function readSessionId(payload: unknown): string {
  const root = asRecord(payload)
  if (!root) return ''
  return asNonEmptyString(root['sessionId'])
}

/**
 * Map a host status to the plugin's internal status.
 * Returns `null` for an unknown status so the caller can ignore the event.
 */
export function mapHostWorkflowStatus(raw: unknown): InternalWorkflowStatus | null {
  switch (raw) {
    case 'running':
      return 'running'
    case 'waiting':
      return 'waiting'
    // The host never emits 'done' — it emits 'completed'.
    case 'completed':
      return 'done'
    // Accepted for backward compatibility with the engine's own spelling.
    case 'done':
      return 'done'
    case 'blocked':
      return 'blocked'
    case 'cancelled':
      return 'cancelled'
    default:
      return null
  }
}

/**
 * Normalise a `workflow.execution.changed` payload.
 *
 * Returns `null` — meaning "ignore this event, launch nothing" — when the
 * payload is incomplete: no session, no execution id, or no usable status.
 */
export function normalizeWorkflowExecutionPayload(payload: unknown): NormalizedWorkflowEvent | null {
  const root = asRecord(payload)
  if (!root) return null

  // The host nests the workflow fields under `data`; fall back to the root
  // for hosts that flatten the payload.
  const data = asRecord(root['data'])
  const source = data ?? root

  const sessionId = readSessionId(root)
  const executionId = asNonEmptyString(source['executionId'])
  const status = mapHostWorkflowStatus(source['status'])

  if (!sessionId || !executionId || !status) return null

  return {
    sessionId,
    executionId,
    workflowId: asNonEmptyString(source['workflowId']),
    status,
  }
}

/**
 * Extract the textual output carried by a `tool.completed` payload.
 *
 * The host wraps the tool result in `data.result` (a ToolResult whose text
 * lives in `output`). The flat `{ sessionId, output }` shape is still
 * accepted for backward compatibility.
 */
export function extractToolOutputText(payload: unknown): string | null {
  const root = asRecord(payload)
  if (!root) return null

  const data = asRecord(root['data'])
  const result = data ? asRecord(data['result']) : null

  const candidates: unknown[] = []
  if (result) candidates.push(result['output'], result['content'], result['text'])
  if (data) candidates.push(data['output'], data['content'])
  candidates.push(root['output'], root['content'])

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return null
}
