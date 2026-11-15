/**
 * AC18 — regression test for the last reported defect.
 *
 * L1 — a dependency that ended 'failed' or 'cancelled' left its dependent
 *      BLOCKED in the legacy queue ONLY, while the control plane said
 *      'queued'.
 *
 * The legacy view used to decide the dependencies on its own, from the
 * ACTIVE queue only. A dependency that had left the active queue
 * (completed, failed or cancelled — it now lives in the history) looked
 * missing, so its dependent was blocked in the legacy queue while the
 * control plane kept it 'queued'. The divergence never healed.
 *
 * The dependency decision now belongs to the control plane, and the
 * legacy view mirrors it.
 *
 * Everything is offline: the shared harness (`test/helpers/sim.ts`).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { _resetLifecycleForTesting, register } from '../src/index.js'
import { makeSim, readJson, rpc, settle } from './helpers/sim.js'
import type { QueueEntry } from '../src/types.js'

const ISSUES = [
  { number: 2, title: 'B', body: 'Depends on #3' },
  { number: 3, title: 'C' },
]

afterEach(() => {
  _resetLifecycleForTesting()
  vi.unstubAllGlobals()
})

describe('AC18 L1 — the dependency decision belongs to the control plane', () => {
  it('does not block the dependent in the legacy view when its dependency was cancelled', async () => {
    const sim = makeSim({
      issues: ISSUES,
      chain: ['plan-issue-v3'],
      settings: { 'ordering.dependencyPattern': '(#(\\d+))' },
    })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)
    await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)

    // The dependency (#3) is cancelled and leaves the active queue.
    const queue = readJson<QueueEntry[]>(sim.backing, 'queue')!
    const dependency = queue.find((e) => e.issueNumber === 3)!
    await rpc(sim, 'automate.cancelIssue')({ queueId: dependency.id }, sim.registry.context)

    // The next scan must not block the dependent in the legacy view only.
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)

    const after = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
    const dependent = after.find((e) => e.issueNumber === 2)
    expect(dependent?.status).not.toBe('blocked')

    const status = (await rpc(sim, 'automate.controlPlaneStatus')({}, sim.registry.context)) as {
      divergences: string[]
    }
    expect(status.divergences).toEqual([])
  })

  it('does not block the dependent when its dependency failed', async () => {
    const sim = makeSim({
      issues: ISSUES,
      chain: ['plan-issue-v3'],
      settings: { 'ordering.dependencyPattern': '(#(\\d+))' },
    })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)

    // The dependency ends 'failed' (as the PR monitor would leave it) and
    // leaves the active queue.
    const queue = readJson<QueueEntry[]>(sim.backing, 'queue')!
    const dependency = queue.find((e) => e.issueNumber === 3)!
    sim.backing.set('history', JSON.stringify([{ ...dependency, status: 'failed', error: 'pr_conflicts' }]))
    sim.backing.set('queue', JSON.stringify(queue.filter((e) => e.issueNumber !== 3)))

    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)

    const after = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
    const dependent = after.find((e) => e.issueNumber === 2)
    expect(dependent?.status).not.toBe('blocked')
  })
})

describe('AC18 L2 — a dependency removed from the queue blocks the dependent in BOTH views', () => {
  it('records the scan-time block in the control plane and mirrors it', async () => {
    const sim = makeSim({
      issues: ISSUES,
      chain: ['plan-issue-v3'],
      settings: { 'ordering.dependencyPattern': '(#(\\d+))' },
    })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)

    // The dependency is removed from the queue AND from the registry.
    const queue = readJson<QueueEntry[]>(sim.backing, 'queue')!
    const dependency = queue.find((e) => e.issueNumber === 3)!
    await rpc(sim, 'automate.removeIssue')({ queueId: dependency.id }, sim.registry.context)

    // The dependency is gone from GitHub too, so the next scan does not
    // bring it back — it is genuinely missing.
    sim.closedIssues.push(3)

    // The next scan must block the dependent in BOTH views.
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)

    const after = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
    const dependent = after.find((e) => e.issueNumber === 2)
    expect(dependent?.status).toBe('blocked')

    const status = (await rpc(sim, 'automate.controlPlaneStatus')({}, sim.registry.context)) as {
      divergences: string[]
    }
    expect(status.divergences).toEqual([])
  })
})
