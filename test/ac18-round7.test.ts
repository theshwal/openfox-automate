/**
 * AC18 — regression tests for the defects found by the SEVENTH
 * verification round.
 *
 *   J1 — the history pruning resurrected a completed issue: the dedup was
 *        based on the LEGACY HISTORY, which is purged, so the next scan
 *        re-queued an issue that had already run. The DURABLE control
 *        plane is the authority.
 *
 *   J2 — the single-issue path (`automate.startIssue`) did not mirror the
 *        dependency block to the legacy entry.
 *
 * Everything is offline: the shared harness (`test/helpers/sim.ts`).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { _resetLifecycleForTesting, register } from '../src/index.js'
import { CONTROL_PLANE_STORAGE_KEY } from '../src/control-plane-store.js'
import { makeSim, readJson, rpc, settle } from './helpers/sim.js'
import type { QueueEntry } from '../src/types.js'

function controlPlane(backing: Map<string, unknown>): {
  items: Record<string, { key: string; status: string; error?: string }>
} {
  return (
    readJson<{
      items: Record<string, { key: string; status: string; error?: string }>
    }>(backing, CONTROL_PLANE_STORAGE_KEY) ?? { items: {} }
  )
}

afterEach(() => {
  _resetLifecycleForTesting()
  vi.unstubAllGlobals()
})

describe('AC18 J1 — the history pruning cannot resurrect a completed issue', () => {
  it('does not re-add it, and creates no second session', async () => {
    // 11 issues, a history that keeps only 10: the oldest completed issue
    // is pruned, so a dedup based on the history would forget it.
    const issues = Array.from({ length: 11 }, (_, i) => ({
      number: i + 1,
      title: `I${i + 1}`,
    }))
    const sim = makeSim({
      issues,
      chain: ['plan-issue-v3'],
      settings: { 'history.retentionCount': 10 },
    })
    register(sim.registry)
    await settle()
    const wfHook = sim.calls.hook.find((h) => h.h === 'workflow.execution.changed')!.fn

    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)
    await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)

    // All the running issues complete.
    const cp = controlPlane(sim.backing)
    let index = 0
    for (const item of Object.values(cp.items)) {
      if (item.status !== 'running') continue
      index += 1
      await wfHook({
        event: 'workflow.execution.changed',
        timestamp: new Date().toISOString(),
        sessionId: `sess-${index}`,
        data: {
          executionId: `exec-${item.key}`,
          workflowId: 'plan-issue-v3',
          workflowName: 'plan-issue-v3',
          status: 'completed',
        },
      })
    }
    const sessionsAfterFirst = sim.sessions.length
    expect(sessionsAfterFirst).toBeGreaterThan(0)

    // The next scan prunes the history, but must NOT re-add the finished
    // issues: the control plane is the durable authority.
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)

    // Only the issues that are STILL running (or queued) are in the queue:
    // the completed ones were not re-added, even though the history was
    // pruned.
    const queued = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
    const cp2 = controlPlane(sim.backing)
    const completed = Object.values(cp2.items).filter((i) => i.status === 'done')
    expect(completed.length).toBeGreaterThan(0)
    for (const done of completed) {
      const number = Number(done.key.split('#')[1])
      expect(queued.find((e) => e.issueNumber === number)).toBeUndefined()
    }

    // And the legacy path must not start them again.
    await sim.calls.hook.find((h) => h.h === 'task.completed')!.fn({})
    expect(sim.sessions).toHaveLength(sessionsAfterFirst)

    const status = (await rpc(sim, 'automate.controlPlaneStatus')({}, sim.registry.context)) as {
      divergences: string[]
    }
    expect(status.divergences).toEqual([])
  })
})

describe('AC18 J2 — the single-issue path mirrors the dependency block', () => {
  it('leaves the entry blocked in both views', async () => {
    // #2 depends on #3, which is removed — so the dependency is missing.
    const sim = makeSim({
      issues: [
        { number: 2, title: 'B', body: 'Depends on #3' },
        { number: 3, title: 'C' },
      ],
      chain: ['plan-issue-v3'],
      settings: { 'ordering.dependencyPattern': '(#(\\d+))' },
    })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)

    // Remove the dependency from BOTH views.
    const queue = readJson<QueueEntry[]>(sim.backing, 'queue')!
    const dep = queue.find((e) => e.issueNumber === 3)!
    await rpc(sim, 'automate.removeIssue')({ queueId: dep.id }, sim.registry.context)

    // The dependent issue can no longer run.
    const dependent = queue.find((e) => e.issueNumber === 2)!
    await expect(
      rpc(sim, 'automate.startIssue')({ queueId: dependent.id }, sim.registry.context),
    ).rejects.toThrow(/blocked/)

    // Both views agree.
    expect(controlPlane(sim.backing).items['acme/widgets#2']?.status).toBe('blocked')
    const after = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
    expect(after.find((e) => e.issueNumber === 2)?.status).toBe('blocked')

    const status = (await rpc(sim, 'automate.controlPlaneStatus')({}, sim.registry.context)) as {
      divergences: string[]
    }
    expect(status.divergences).toEqual([])
  })
})
