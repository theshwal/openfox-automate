/**
 * AC18 — regression tests for the defects found by the EIGHTH
 * verification round.
 *
 *   K1 — a rescan re-blocked a RUNNING issue whose dependency had just
 *        completed (the registry did not know the dependency was
 *        satisfied), so the two views diverged.
 *
 *   K2 — a FAILED issue was resurrected by the history pruning: the dedup
 *        filtered the 'done'/'cancelled' items of the durable registry
 *        but not the 'failed' ones.
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

describe('AC18 K1 — a rescan does not block a running issue whose dependency completed', () => {
  it('keeps the two views in agreement and does not lose the worker slot', async () => {
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
    await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)

    // The DEPENDENCY (#3) is the one that runs first; it completes and
    // moves to the history.
    const cp0 = controlPlane(sim.backing)
    const dependency = Object.values(cp0.items).find((i) => i.key.endsWith('#3'))
    expect(dependency?.status).toBe('running')
    await sim.calls.hook
      .find((h) => h.h === 'workflow.execution.changed')!
      .fn({
        event: 'workflow.execution.changed',
        timestamp: new Date().toISOString(),
        sessionId: 'sess-1',
        data: {
          executionId: 'exec-1',
          workflowId: 'plan-issue-v3',
          workflowName: 'plan-issue-v3',
          status: 'completed',
        },
      })

    // The rescan must not re-block the dependent issue.
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)

    const cp = controlPlane(sim.backing)
    expect(cp.items['acme/widgets#2']?.status).not.toBe('blocked')

    const queue = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
    const dependent = queue.find((e) => e.issueNumber === 2)
    expect(dependent?.status).not.toBe('blocked')

    const status = (await rpc(sim, 'automate.controlPlaneStatus')({}, sim.registry.context)) as {
      divergences: string[]
    }
    expect(status.divergences).toEqual([])
  })
})

describe('AC18 K2 — a failed issue is not resurrected by the history pruning', () => {
  it('does not re-add it after the history was pruned', async () => {
    // 11 issues, a history that keeps 10. The oldest FAILED issue is pruned,
    // so a dedup based on the history would forget it.
    const issues = Array.from({ length: 11 }, (_, i) => ({ number: i + 1, title: `I${i + 1}` }))
    const sim = makeSim({
      issues,
      chain: ['plan-issue-v3'],
      settings: { 'history.retentionCount': 10 },
    })
    register(sim.registry)
    await settle()

    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)

    // Every issue FAILED: the durable registry says 'failed' and the legacy
    // entry is in the history (as the PR monitor would leave it).
    const cp = controlPlane(sim.backing)
    for (const key of Object.keys(cp.items)) {
      cp.items[key]!.status = 'failed'
      cp.items[key]!.error = 'pr_conflicts'
    }
    sim.backing.set(CONTROL_PLANE_STORAGE_KEY, JSON.stringify(cp))
    const queue = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
    sim.backing.set(
      'history',
      JSON.stringify(queue.map((e) => ({ ...e, status: 'failed', error: 'pr_conflicts' }))),
    )
    sim.backing.set('queue', JSON.stringify([]))

    // A rescan prunes the history, but must not re-add the failed issues.
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)

    const queued = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
    expect(queued).toHaveLength(0)

    const status = (await rpc(sim, 'automate.controlPlaneStatus')({}, sim.registry.context)) as {
      divergences: string[]
    }
    expect(status.divergences).toEqual([])
  })
})
