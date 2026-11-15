/**
 * Unit tests for the host event adapters (`src/host-events.ts`).
 *
 * The host shapes are documented in that module; these tests pin the
 * normalisation rules at the boundary so a change in the host contract
 * fails here first.
 */

import { describe, expect, it } from 'vitest'

import {
  extractToolOutputText,
  mapHostWorkflowStatus,
  normalizeWorkflowExecutionPayload,
  readSessionId,
} from '../src/host-events.js'

describe('mapHostWorkflowStatus', () => {
  it('normalises the host vocabulary', () => {
    expect(mapHostWorkflowStatus('running')).toBe('running')
    expect(mapHostWorkflowStatus('waiting')).toBe('waiting')
    // The host never emits 'done': it emits 'completed'.
    expect(mapHostWorkflowStatus('completed')).toBe('done')
    expect(mapHostWorkflowStatus('blocked')).toBe('blocked')
    expect(mapHostWorkflowStatus('cancelled')).toBe('cancelled')
  })

  it('returns null for an unknown status', () => {
    expect(mapHostWorkflowStatus('done-ish')).toBeNull()
    expect(mapHostWorkflowStatus(undefined)).toBeNull()
    expect(mapHostWorkflowStatus(null)).toBeNull()
    expect(mapHostWorkflowStatus(42)).toBeNull()
  })
})

describe('normalizeWorkflowExecutionPayload', () => {
  it('reads the host shape (fields under data)', () => {
    const result = normalizeWorkflowExecutionPayload({
      event: 'workflow.execution.changed',
      timestamp: '2026-11-10T00:00:00.000Z',
      sessionId: 'sess-1',
      projectId: 'proj-1',
      data: {
        executionId: 'exec-1',
        workflowId: 'plan-issue-v3',
        workflowName: 'Plan Issue v3',
        status: 'completed',
        currentStepId: 'plan',
        pendingChoices: [],
      },
    })

    expect(result).toEqual({
      sessionId: 'sess-1',
      executionId: 'exec-1',
      workflowId: 'plan-issue-v3',
      status: 'done',
    })
  })

  it('accepts the legacy flat shape (fields at the root)', () => {
    const result = normalizeWorkflowExecutionPayload({
      sessionId: 'sess-1',
      workflowId: 'plan-issue-v3',
      executionId: 'exec-1',
      status: 'done',
    })

    expect(result).toEqual({
      sessionId: 'sess-1',
      executionId: 'exec-1',
      workflowId: 'plan-issue-v3',
      status: 'done',
    })
  })

  it('returns null for an incomplete payload', () => {
    expect(normalizeWorkflowExecutionPayload(null)).toBeNull()
    expect(normalizeWorkflowExecutionPayload(undefined)).toBeNull()
    expect(normalizeWorkflowExecutionPayload({})).toBeNull()
    // No executionId.
    expect(
      normalizeWorkflowExecutionPayload({ sessionId: 's', data: { workflowId: 'w', status: 'completed' } }),
    ).toBeNull()
    // No sessionId.
    expect(
      normalizeWorkflowExecutionPayload({ data: { executionId: 'e', workflowId: 'w', status: 'completed' } }),
    ).toBeNull()
    // Unknown status.
    expect(
      normalizeWorkflowExecutionPayload({
        sessionId: 's',
        data: { executionId: 'e', workflowId: 'w', status: 'exploded' },
      }),
    ).toBeNull()
  })

  it('never throws on a hostile payload', () => {
    const hostile = [
      { sessionId: 42, data: 'not-an-object' },
      { sessionId: 's', data: { executionId: {}, status: 'completed' } },
      { sessionId: 's', data: { executionId: 'e', status: 'completed', workflowId: 7 } },
      'a-string',
      123,
      [],
    ]
    for (const payload of hostile) {
      expect(() => normalizeWorkflowExecutionPayload(payload)).not.toThrow()
    }
  })
})

describe('readSessionId', () => {
  it('reads the session id from the root', () => {
    expect(readSessionId({ sessionId: 'sess-1' })).toBe('sess-1')
  })

  it('returns an empty string when absent or malformed', () => {
    expect(readSessionId({})).toBe('')
    expect(readSessionId(null)).toBe('')
    expect(readSessionId({ sessionId: 7 })).toBe('')
  })
})

describe('extractToolOutputText', () => {
  it('reads the host shape data.result.output', () => {
    const text = extractToolOutputText({
      event: 'tool.completed',
      sessionId: 'sess-1',
      data: {
        messageId: 'msg-1',
        toolCallId: 'call-1',
        result: { success: true, output: 'Opened https://github.com/o/r/pull/42', durationMs: 5 },
      },
    })
    expect(text).toBe('Opened https://github.com/o/r/pull/42')
  })

  it('accepts the legacy flat shape', () => {
    expect(extractToolOutputText({ sessionId: 'sess-1', output: 'legacy' })).toBe('legacy')
  })

  it('returns null when there is no textual output', () => {
    expect(extractToolOutputText({ sessionId: 's', data: { result: { success: true } } })).toBeNull()
    expect(
      extractToolOutputText({ sessionId: 's', data: { result: { success: false, error: 'boom' } } }),
    ).toBeNull()
    expect(extractToolOutputText({})).toBeNull()
    expect(extractToolOutputText(null)).toBeNull()
  })
})
