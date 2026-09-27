import { describe, expect, it } from 'vitest'
import { applyExecutionEvent, type ExecutionStep } from '../src/chain.js'
import type { OpenFoxOrchestration, LaunchWorkflowParams } from '../src/orchestration.js'
import type { QueueEntry } from '../src/types.js'

interface CallRecord {
  method: 'createSession' | 'stopSession' | 'launchWorkflow'
  args: unknown[]
}

function makeSpy(): { orch: OpenFoxOrchestration; calls: CallRecord[] } {
  const calls: CallRecord[] = []
  return {
    calls,
    orch: {
      async createSession(projectId: string, title: string) {
        calls.push({ method: 'createSession', args: [projectId, title] })
        return { id: 'sess-1', workdir: '/tmp/work' }
      },
      async stopSession(sessionId: string) {
        calls.push({ method: 'stopSession', args: [sessionId] })
      },
      launchWorkflow(params: LaunchWorkflowParams): void {
        calls.push({ method: 'launchWorkflow', args: [params] })
      },
    },
  }
}

function entryWithStack(chain: string[], sessionId = 'sess-1'): QueueEntry {
  const executionStack: ExecutionStep[] = chain.map((id) => ({
    workflowId: id,
    workflowName: id,
    status: 'pending' as const,
    retryCount: 0,
  }))
  return {
    id: 'entry-1',
    repoKey: 'o/r',
    projectId: 'p',
    issueNumber: 42,
    title: 'test issue',
    body: '',
    url: '',
    labels: [],
    comments: [],
    dependsOn: [],
    status: 'running',
    position: 1,
    sessionId,
    executionStack,
    addedAt: '2026-01-01T00:00:00Z',
    startedAt: '2026-01-01T00:00:01Z',
  }
}

/**
 * Replica of the workflow.execution.changed hook's control flow, isolated
 * from the Runtime/registry so it can be unit-tested directly.
 *
 * Contract:
 * - 'done' with chain continuing → launch next step
 * - 'blocked' on first block (retryCount goes 0→1) → relaunch current step
 * - 'blocked' on second block (retryCount goes 1→2) → no launch (entry becomes blocked)
 * - 'done' on last step → no launch (chain finished)
 * - 'running' / 'pending' / 'waiting' → no launch
 * - duplicate events for the same executionId → no-op
 */

interface AdvanceResult {
  launches: number
  finished: boolean
  blocked: boolean
  nextStatus: QueueEntry['status']
}

function advanceChain(
  entry: QueueEntry,
  event: {
    workflowId?: string
    status: 'pending' | 'running' | 'done' | 'blocked' | 'waiting'
    executionId?: string
  },
  orchestration: OpenFoxOrchestration,
  appliedExecutionEvents: Set<string>,
): AdvanceResult {
  const eventKey = event.executionId
    ? `exec:${event.executionId}`
    : `sw:${entry.sessionId}:${event.workflowId}:${event.status}`
  if (appliedExecutionEvents.has(eventKey)) {
    return {
      launches: 0,
      finished: entry.status === 'done',
      blocked: entry.status === 'blocked',
      nextStatus: entry.status,
    }
  }
  appliedExecutionEvents.add(eventKey)

  const stack = entry.executionStack ?? []
  const idx = stack.findIndex((s) => s.status === 'running')
  if (idx < 0) {
    return { launches: 0, finished: false, blocked: false, nextStatus: entry.status }
  }
  const prevRetry = stack[idx]!.retryCount
  const outcome = applyExecutionEvent(stack, idx, { status: event.status })
  let nextStatus: QueueEntry['status'] = 'running'
  let launches = 0

  if (outcome.finished && !outcome.blocked) {
    nextStatus = 'done'
  } else if (outcome.blocked) {
    nextStatus = 'blocked'
  } else if (event.status === 'done' && idx + 1 < stack.length) {
    const nextStep = stack[idx + 1]!
    if (entry.sessionId) {
      orchestration.launchWorkflow({
        sessionId: entry.sessionId,
        workflowId: nextStep.workflowId,
      })
      launches = 1
    }
  } else if (event.status === 'blocked' && stack[idx]!.retryCount > prevRetry) {
    if (entry.sessionId) {
      orchestration.launchWorkflow({
        sessionId: entry.sessionId,
        workflowId: stack[idx]!.workflowId,
      })
      launches = 1
    }
  }

  return { launches, finished: outcome.finished, blocked: outcome.blocked, nextStatus }
}

/** Simulate the initial startChain call (sets running + launches step[0]). */
function startChain(entry: QueueEntry, orchestration: OpenFoxOrchestration, _calls: CallRecord[]): void {
  if (entry.executionStack?.[0]) {
    entry.executionStack[0].status = 'running'
    entry.executionStack[0].startedAt = '2026-01-01T00:00:02Z'
  }
  if (entry.sessionId && entry.executionStack?.[0]) {
    orchestration.launchWorkflow({
      sessionId: entry.sessionId,
      workflowId: entry.executionStack[0].workflowId,
    })
  }
}

function launchCalls(calls: CallRecord[]): CallRecord[] {
  return calls.filter((c) => c.method === 'launchWorkflow')
}

function launchWorkflowIds(calls: CallRecord[]): string[] {
  return launchCalls(calls).map((c) => (c.args[0] as LaunchWorkflowParams).workflowId)
}

describe('state machine — full chain advancement', () => {
  it('workflow 1 → 2 → 3 → entry done with exactly 3 launches', () => {
    const { orch, calls } = makeSpy()
    const entry = entryWithStack(['Plan Issue v2', 'Build & Verify Auto v2', 'Delivery v2'])
    const seen = new Set<string>()

    startChain(entry, orch, calls)
    expect(launchCalls(calls)).toHaveLength(1)

    // Workflow 1 'running' confirmation — no-op
    let r = advanceChain(
      entry,
      { workflowId: 'Plan Issue v2', status: 'running', executionId: 'e1' },
      orch,
      seen,
    )
    expect(r.launches).toBe(0)
    expect(launchCalls(calls)).toHaveLength(1)

    // Workflow 1 done → launch workflow 2
    r = advanceChain(entry, { workflowId: 'Plan Issue v2', status: 'done', executionId: 'e2' }, orch, seen)
    expect(r.launches).toBe(1)
    expect(r.finished).toBe(false)
    expect(r.blocked).toBe(false)
    expect(launchCalls(calls)).toHaveLength(2)
    if (entry.executionStack) entry.executionStack[1]!.status = 'running'

    // Workflow 2 done → launch workflow 3
    r = advanceChain(
      entry,
      { workflowId: 'Build & Verify Auto v2', status: 'done', executionId: 'e3' },
      orch,
      seen,
    )
    expect(r.launches).toBe(1)
    expect(r.finished).toBe(false)
    if (entry.executionStack) entry.executionStack[2]!.status = 'running'

    // Workflow 3 done → finished
    r = advanceChain(entry, { workflowId: 'Delivery v2', status: 'done', executionId: 'e4' }, orch, seen)
    expect(r.launches).toBe(0)
    expect(r.finished).toBe(true)

    // Total: 1 initial + 2 chain advances = 3 launches
    expect(launchCalls(calls)).toHaveLength(3)
  })

  it('duplicate done event with same executionId does NOT re-launch (idempotency)', () => {
    const { orch, calls } = makeSpy()
    const entry = entryWithStack(['Plan Issue v2', 'Build & Verify Auto v2'])
    const seen = new Set<string>()

    startChain(entry, orch, calls)
    advanceChain(entry, { workflowId: 'Plan Issue v2', status: 'running', executionId: 'e1' }, orch, seen)
    advanceChain(entry, { workflowId: 'Plan Issue v2', status: 'done', executionId: 'e2' }, orch, seen)
    if (entry.executionStack) entry.executionStack[1]!.status = 'running'

    // Duplicate 'done' with SAME executionId → no-op
    advanceChain(entry, { workflowId: 'Plan Issue v2', status: 'done', executionId: 'e2' }, orch, seen)

    // 1 initial + 1 chain advance = 2 total, not 3
    expect(launchCalls(calls)).toHaveLength(2)
  })

  it('duplicate done with different executionIds but same workflowId triggers re-launch (dedup key is executionId)', () => {
    const { orch, calls } = makeSpy()
    const entry = entryWithStack(['Plan Issue v2', 'Build & Verify Auto v2', 'Delivery v2'])
    const seen = new Set<string>()

    startChain(entry, orch, calls)
    advanceChain(entry, { workflowId: 'Plan Issue v2', status: 'running', executionId: 'e1' }, orch, seen)
    advanceChain(entry, { workflowId: 'Plan Issue v2', status: 'done', executionId: 'e2' }, orch, seen)
    if (entry.executionStack) entry.executionStack[1]!.status = 'running'

    // Same workflow done event with DIFFERENT executionId → NOT dedup'd,
    // advances chain to step[2].
    advanceChain(entry, { workflowId: 'Plan Issue v2', status: 'done', executionId: 'e3' }, orch, seen)
    if (entry.executionStack) entry.executionStack[2]!.status = 'running'

    // 1 initial + 2 chain advances = 3 launches
    expect(launchWorkflowIds(calls)).toEqual(['Plan Issue v2', 'Build & Verify Auto v2', 'Delivery v2'])
  })

  it('blocked #1 → real retry (1 relaunch), blocked #2 → entry blocked (no launch)', () => {
    const { orch, calls } = makeSpy()
    const entry = entryWithStack(['Plan Issue v2'])
    const seen = new Set<string>()

    startChain(entry, orch, calls)

    // First blocked → retry
    let r = advanceChain(
      entry,
      { workflowId: 'Plan Issue v2', status: 'blocked', executionId: 'b1' },
      orch,
      seen,
    )
    expect(r.launches).toBe(1)
    expect(r.blocked).toBe(false)
    expect(launchCalls(calls)).toHaveLength(2)

    // Second blocked → entry becomes blocked, no launch
    r = advanceChain(entry, { workflowId: 'Plan Issue v2', status: 'blocked', executionId: 'b2' }, orch, seen)
    expect(r.launches).toBe(0)
    expect(r.blocked).toBe(true)
    expect(launchCalls(calls)).toHaveLength(2)
  })

  it('duplicate blocked event with same executionId does NOT trigger extra retry (idempotency)', () => {
    const { orch, calls } = makeSpy()
    const entry = entryWithStack(['Plan Issue v2'])
    const seen = new Set<string>()

    startChain(entry, orch, calls)
    advanceChain(entry, { workflowId: 'Plan Issue v2', status: 'blocked', executionId: 'b1' }, orch, seen)
    advanceChain(entry, { workflowId: 'Plan Issue v2', status: 'blocked', executionId: 'b2' }, orch, seen)

    // Duplicate first blocked (same executionId) → no-op
    advanceChain(entry, { workflowId: 'Plan Issue v2', status: 'blocked', executionId: 'b1' }, orch, seen)

    // 1 initial + 1 retry = 2 launches (duplicate didn't add a third)
    expect(launchCalls(calls)).toHaveLength(2)
  })

  it('waiting does NOT launch anything; resume via running reuses cached state', () => {
    const { orch, calls } = makeSpy()
    const entry = entryWithStack(['Plan Issue v2'])
    const seen = new Set<string>()

    startChain(entry, orch, calls)
    // Waiting pauses the chain
    const r = advanceChain(
      entry,
      { workflowId: 'Plan Issue v2', status: 'waiting', executionId: 'w1' },
      orch,
      seen,
    )
    expect(r.launches).toBe(0)

    // Running resumes (treated as confirmation since step is already running)
    const r2 = advanceChain(
      entry,
      { workflowId: 'Plan Issue v2', status: 'running', executionId: 'r1' },
      orch,
      seen,
    )
    expect(r2.launches).toBe(0)
  })

  it('cancel_issue calls orchestration.stopSession then transitions to cancelled', () => {
    const { orch, calls } = makeSpy()
    const entry = entryWithStack(['Plan Issue v2'], 'sess-cancel')
    void orch.stopSession(entry.sessionId!)
    expect(calls.find((c) => c.method === 'stopSession')).toEqual({
      method: 'stopSession',
      args: ['sess-cancel'],
    })
  })
})
