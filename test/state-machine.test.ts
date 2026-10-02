import { beforeEach, describe, expect, it } from 'vitest'
import {
  processWorkflowEvent,
  buildIssueContext,
  buildIssueParams,
  purgeAppliedExecutionEvents,
  type ExecutionStep,
} from '../src/chain.js'
import type { QueueEntry } from '../src/types.js'

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
    url: 'https://github.com/o/r/issues/42',
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

function processDeps() {
  return {
    appliedExecutionEvents: new Set<string>(),
    log: (_msg: string) => {},
    buildIssueContext,
    buildIssueParams,
  }
}

function startChain(entry: QueueEntry): void {
  if (entry.executionStack?.[0]) {
    entry.executionStack[0].status = 'running'
    entry.executionStack[0].startedAt = '2026-01-01T00:00:02Z'
  }
}

function feed(
  entry: QueueEntry,
  events: Array<{
    workflowId: string
    status: 'pending' | 'running' | 'done' | 'blocked' | 'waiting'
    executionId: string
  }>,
  appliedExecutionEvents?: Set<string>,
) {
  const seen = appliedExecutionEvents ?? new Set<string>()
  const results = []
  for (const e of events) {
    const r = processWorkflowEvent(
      entry,
      {
        workflowId: e.workflowId,
        status: e.status,
        executionId: e.executionId,
        sessionId: entry.sessionId ?? '',
      },
      { ...processDeps(), appliedExecutionEvents: seen },
    )
    results.push(r)
  }
  return results
}

describe('state machine — production code (processWorkflowEvent)', () => {
  beforeEach(() => {})

  it('full chain: workflow 1 → 2 → 3 → entry done', () => {
    const entry = entryWithStack(['plan-issue-v3', 'build-verify-v3', 'publish-pr-v1'])
    startChain(entry)

    const seen = new Set<string>()
    const all: ReturnType<typeof feed> = []
    let curIdx = 1
    function promote() {
      entry.executionStack![curIdx]!.status = 'running'
      curIdx++
    }
    all.push(...feed(entry, [{ workflowId: 'plan-issue-v3', status: 'running', executionId: 'e1' }], seen))
    all.push(...feed(entry, [{ workflowId: 'plan-issue-v3', status: 'done', executionId: 'e2' }], seen))
    promote()
    all.push(...feed(entry, [{ workflowId: 'build-verify-v3', status: 'done', executionId: 'e3' }], seen))
    promote()
    all.push(...feed(entry, [{ workflowId: 'publish-pr-v1', status: 'done', executionId: 'e4' }], seen))

    expect(all[0]!.launches).toHaveLength(0)
    expect(all[1]!.launches.map((l) => l.workflowId)).toEqual(['build-verify-v3'])
    expect(all[2]!.launches.map((l) => l.workflowId)).toEqual(['publish-pr-v1'])
    expect(all[3]!.launches).toHaveLength(0)
    expect(all[3]!.finished).toBe(true)
    expect(all[3]!.transitionTo).toBe('done')
  })

  it('duplicate done event with same executionId does NOT re-launch (idempotency)', () => {
    const entry = entryWithStack(['plan-issue-v3', 'build-verify-v3'])
    startChain(entry)

    const seen = new Set<string>()
    feed(
      entry,
      [
        { workflowId: 'plan-issue-v3', status: 'running', executionId: 'e1' },
        { workflowId: 'plan-issue-v3', status: 'done', executionId: 'e2' },
      ],
      seen,
    )
    entry.executionStack![1]!.status = 'running'

    const dup = feed(entry, [{ workflowId: 'plan-issue-v3', status: 'done', executionId: 'e2' }], seen)

    expect(dup[0]!.deduplicated).toBe(true)
    expect(dup[0]!.launches).toHaveLength(0)
  })

  it('same executionId with different status is NOT deduplicated (running then done)', () => {
    const entry = entryWithStack(['plan-issue-v3', 'build-verify-v3'])
    startChain(entry)

    const seen = new Set<string>()
    const results = feed(
      entry,
      [
        { workflowId: 'plan-issue-v3', status: 'running', executionId: 'exec-1' },
        { workflowId: 'plan-issue-v3', status: 'done', executionId: 'exec-1' },
      ],
      seen,
    )

    expect(results[0]!.deduplicated).toBe(false)
    expect(results[1]!.deduplicated).toBe(false)
    expect(results[1]!.launches).toHaveLength(1)
    expect(results[1]!.launches[0]?.workflowId).toBe('build-verify-v3')
  })

  it('duplicate done with different executionIds but same workflowId triggers re-launch', () => {
    const entry = entryWithStack(['plan-issue-v3', 'build-verify-v3', 'publish-pr-v1'])
    startChain(entry)

    const seen = new Set<string>()
    feed(
      entry,
      [
        { workflowId: 'plan-issue-v3', status: 'running', executionId: 'e1' },
        { workflowId: 'plan-issue-v3', status: 'done', executionId: 'e2' },
      ],
      seen,
    )
    entry.executionStack![1]!.status = 'running'

    const seen2 = new Set<string>()
    const results = feed(
      entry,
      [
        { workflowId: 'build-verify-v3', status: 'running', executionId: 'e1b' },
        { workflowId: 'plan-issue-v3', status: 'done', executionId: 'e3' },
      ],
      seen2,
    )
    entry.executionStack![2]!.status = 'running'

    expect(results[1]!.launches.map((l) => l.workflowId)).toEqual(['publish-pr-v1'])
  })

  it('blocked #1 → real retry (1 relaunch), blocked #2 → entry blocked (no launch)', () => {
    const entry = entryWithStack(['plan-issue-v3'])
    startChain(entry)

    const seen = new Set<string>()
    const results = feed(
      entry,
      [
        { workflowId: 'plan-issue-v3', status: 'running', executionId: 'b0' },
        { workflowId: 'plan-issue-v3', status: 'blocked', executionId: 'b1' },
        { workflowId: 'plan-issue-v3', status: 'blocked', executionId: 'b2' },
      ],
      seen,
    )

    expect(results[1]!.launches).toHaveLength(1)
    expect(results[1]!.launches[0]?.workflowId).toBe('plan-issue-v3')
    expect(results[1]!.transitionTo).toBeUndefined()

    expect(results[2]!.launches).toHaveLength(0)
    expect(results[2]!.transitionTo).toBe('blocked')
  })

  it('duplicate blocked event with same executionId does NOT trigger extra retry', () => {
    const entry = entryWithStack(['plan-issue-v3'])
    startChain(entry)

    const seen = new Set<string>()
    feed(
      entry,
      [
        { workflowId: 'plan-issue-v3', status: 'running', executionId: 'b0' },
        { workflowId: 'plan-issue-v3', status: 'blocked', executionId: 'b1' },
        { workflowId: 'plan-issue-v3', status: 'blocked', executionId: 'b2' },
      ],
      seen,
    )

    const dup = feed(entry, [{ workflowId: 'plan-issue-v3', status: 'blocked', executionId: 'b1' }], seen)

    expect(dup[0]!.deduplicated).toBe(true)
    expect(dup[0]!.launches).toHaveLength(0)
  })

  it('waiting does NOT launch; running after waiting is also a no-op', () => {
    const entry = entryWithStack(['plan-issue-v3'])
    startChain(entry)

    const seen = new Set<string>()
    const results = feed(
      entry,
      [
        { workflowId: 'plan-issue-v3', status: 'running', executionId: 'r0' },
        { workflowId: 'plan-issue-v3', status: 'waiting', executionId: 'w1' },
        { workflowId: 'plan-issue-v3', status: 'running', executionId: 'r1' },
      ],
      seen,
    )

    expect(results[1]!.launches).toHaveLength(0)
    expect(results[1]!.transitionTo).toBeUndefined()
    expect(results[2]!.launches).toHaveLength(0)
  })

  it('event without executionId is rejected (logged) and not processed', () => {
    const entry = entryWithStack(['plan-issue-v3'])
    startChain(entry)

    let logged = ''
    const r = processWorkflowEvent(
      entry,
      { workflowId: 'plan-issue-v3', status: 'done', sessionId: entry.sessionId ?? '' },
      {
        appliedExecutionEvents: new Set<string>(),
        log: (msg) => {
          logged = msg
        },
        buildIssueContext,
        buildIssueParams,
      },
    )

    expect(r.launches).toHaveLength(0)
    expect(r.transitionTo).toBeUndefined()
    expect(r.deduplicated).toBe(false)
    expect(logged).toMatch(/without executionId/)
  })

  it('chain advance populates content and params via buildIssueContext/buildIssueParams', () => {
    const entry = entryWithStack(['plan-issue-v3', 'build-verify-v3'])
    startChain(entry)

    const seen = new Set<string>()
    const results = feed(
      entry,
      [
        { workflowId: 'plan-issue-v3', status: 'running', executionId: 'e1' },
        { workflowId: 'plan-issue-v3', status: 'done', executionId: 'e2' },
      ],
      seen,
    )

    const launch = results[1]!.launches[0]!
    expect(launch.sessionId).toBe('sess-1')
    expect(launch.workflowId).toBe('build-verify-v3')
    expect(launch.content).toContain('**Title:** test issue')
    expect(launch.params.issue_url).toBe('https://github.com/o/r/issues/42')
    expect(launch.params.issue_number).toBe('42')
    expect(launch.params.repo_key).toBe('o/r')
    expect(launch.params.project_id).toBe('p')
  })

  it('last workflow done → entry transitions to done', () => {
    const entry = entryWithStack(['plan-issue-v3'])
    startChain(entry)

    const seen = new Set<string>()
    const results = feed(
      entry,
      [
        { workflowId: 'plan-issue-v3', status: 'running', executionId: 'e1' },
        { workflowId: 'plan-issue-v3', status: 'done', executionId: 'e2' },
      ],
      seen,
    )

    expect(results[1]!.launches).toHaveLength(0)
    expect(results[1]!.finished).toBe(true)
    expect(results[1]!.transitionTo).toBe('done')
  })

  it('purgeAppliedExecutionEvents removes only matching keys', () => {
    const set = new Set<string>(['exec-1:done', 'exec-2:blocked', 'sw-fallback:done'])
    purgeAppliedExecutionEvents(set, (k) => k.startsWith('exec-1:'))
    expect(set.has('exec-1:done')).toBe(false)
    expect(set.has('exec-2:blocked')).toBe(true)
    expect(set.has('sw-fallback:done')).toBe(true)

    purgeAppliedExecutionEvents(set, () => true)
    expect(set.size).toBe(0)
  })
})
