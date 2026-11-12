/**
 * AC18-13 — A dependency removed from the queue must not diverge the views,
 * and must never clobber a RUNNING issue.
 *
 * The defect: `automate.removeIssue` deletes the item from the durable
 * registry, but the DEPENDENT keeps `dependsOn=[3]`. The scan-time
 * dependency decision then blocked the dependent in the LEGACY view only
 * ('missing or circular dependency'), while the control plane kept it
 * 'queued' — the two views disagreed permanently, and a dependent that
 * was already RUNNING got clobbered mid-run.
 *
 * The fix: the scan-time dependency decision belongs to the control
 * plane. It is recorded THERE first, and the legacy entry is written from
 * it.
 *
 * AC18-24 — the token budget applies to the single-issue path too.
 *
 * Everything is offline: the shared harness (`test/helpers/sim.ts`).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { _resetLifecycleForTesting, register } from '../src/index.js'
import { makeSim, readJson, rpc, settle } from './helpers/sim.js'
import type { QueueEntry } from '../src/types.js'

const CHAIN = ['plan-issue-v3', 'build-verify-v3', 'publish-pr-v1']

const ISSUES = [
  { number: 2, title: 'B', body: 'Depends on #3' },
  { number: 3, title: 'C' },
]

/** The session the running control-plane item is bound to. */
function runningSessionOf(cp: { items: Record<string, { status: string; sessionId?: string }> }): string {
  const running = Object.values(cp.items).find((i) => i.status === 'running')
  return running?.sessionId ?? 'sess-1'
}

function controlPlane(backing: Map<string, unknown>): {
  items: Record<string, { key: string; status: string; error?: string; sessionId?: string }>
} {
  return (
    readJson<{
      items: Record<string, { key: string; status: string; error?: string; sessionId?: string }>
    }>(backing, 'control_plane') ?? { items: {} }
  )
}

afterEach(() => {
  _resetLifecycleForTesting()
  vi.unstubAllGlobals()
})

describe('AC18-13 — a removed dependency never diverges the views', () => {
  it('blocks the dependent in BOTH views after removeIssue + scan', async () => {
    const sim = makeSim({
      issues: ISSUES,
      chain: CHAIN,
      settings: { 'ordering.dependencyPattern': '(#(\\d+))' },
    })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)

    // #3 is closed on GitHub but still lingers in the queue.
    const queue = readJson<QueueEntry[]>(sim.backing, 'queue')!
    const dependency = queue.find((e) => e.issueNumber === 3)!
    sim.closedIssues.push(3)
    await rpc(sim, 'automate.removeIssue')({ queueId: dependency.id }, sim.registry.context)

    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)

    // The two views agree.
    const cp = controlPlane(sim.backing)
    const legacy = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
    const dependentLegacy = legacy.find((e) => e.issueNumber === 2)
    const dependentCp = cp.items['acme/widgets#2']
    expect(dependentCp?.status).toBe(dependentLegacy?.status)
    expect(dependentLegacy?.status).toBe('blocked')

    const status = (await rpc(sim, 'automate.controlPlaneStatus')({}, sim.registry.context)) as {
      divergences: string[]
    }
    expect(status.divergences).toEqual([])
  })

  it('NEVER clobbers a RUNNING dependent', async () => {
    const sim = makeSim({
      issues: ISSUES,
      chain: CHAIN,
      settings: { 'ordering.dependencyPattern': '(#(\\d+))' },
    })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)
    await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)
    // The launch is asynchronous: the session is recorded after the host
    // round-trip.
    await settle()

    // #3 (the dependency) runs first. It completes, so #2 becomes
    // schedulable and runs too.
    const wfHook = sim.calls.hook.find((h) => h.h === 'workflow.execution.changed')!.fn
    for (const step of CHAIN) {
      await wfHook({
        event: 'workflow.execution.changed',
        timestamp: new Date().toISOString(),
        // The session the RUNNING issue actually uses.
        sessionId: runningSessionOf(controlPlane(sim.backing)),
        data: {
          executionId: `exec-${step}`,
          workflowId: step,
          workflowName: step,
          status: 'completed',
        },
      })
    }
    // The dependency is done, so the DEPENDENT becomes schedulable.
    await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)
    // The launch is asynchronous: give the host round-trips a chance.
    await settle()

    // Now the DEPENDENT (#2) is the running one.
    const cp = controlPlane(sim.backing)

    const running = Object.values(cp.items).find((i) => i.status === 'running')
    expect(running?.key).toBe('acme/widgets#2')

    // Its dependency (#3) is removed while #2 runs.
    const queue = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
    const dependency = queue.find((e) => e.issueNumber === 3)
    if (dependency) {
      sim.closedIssues.push(3)
      await rpc(sim, 'automate.removeIssue')({ queueId: dependency.id }, sim.registry.context)
    }

    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)

    // The RUNNING dependent was NOT clobbered: it keeps running, and the
    // two views still agree.
    const after = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
    const dependent = after.find((e) => e.issueNumber === 2)
    expect(dependent?.status).toBe('running')

    const status = (await rpc(sim, 'automate.controlPlaneStatus')({}, sim.registry.context)) as {
      divergences: string[]
    }
    expect(status.divergences).toEqual([])
  })

  it('never blocks a RUNNING item in the control plane either', async () => {
    // The scan-time block must not touch an item whose workflow is in
    // flight: aborting it would leave a live session behind.
    const sim = makeSim({
      issues: ISSUES,
      chain: CHAIN,
      settings: { 'ordering.dependencyPattern': '(#(\\d+))' },
    })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)
    await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)
    // The launch is asynchronous: the session is recorded after the host
    // round-trip.
    await settle()

    // #3 (the dependency) is running. Force the dependency check to fail
    // for the running item by removing it from the registry while #3 runs,
    // then rescan: neither view may be clobbered.
    const cp = controlPlane(sim.backing)
    const running = Object.values(cp.items).find((i) => i.status === 'running')
    expect(running).toBeDefined()

    // The DEPENDENCY of the running item vanishes: #3 completed (so #2 was
    // schedulable and ran), and #3 is then removed from the registry. The
    // dependency check now fails for #2 — which is RUNNING. It must not be
    // clobbered: its workflow is in flight and its session is live.
    const wfHook = sim.calls.hook.find((h) => h.h === 'workflow.execution.changed')!.fn
    for (const step of CHAIN) {
      await wfHook({
        event: 'workflow.execution.changed',
        timestamp: new Date().toISOString(),
        // The session the RUNNING issue actually uses.
        sessionId: runningSessionOf(controlPlane(sim.backing)),
        data: {
          executionId: `exec-${step}`,
          workflowId: step,
          workflowName: step,
          status: 'completed',
        },
      })
    }
    await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)
    await settle()

    // #2 is now the running one.
    const cpBefore = controlPlane(sim.backing)
    expect(Object.values(cpBefore.items).find((i) => i.status === 'running')?.key).toBe('acme/widgets#2')

    // Its dependency (#3) leaves the registry ENTIRELY: it is neither
    // known nor satisfied any more, so the dependency check fails for #2.
    // #2 is RUNNING: it must not be blocked in either view.
    //
    // This is the case that requires BOTH guards: without the control
    // plane's "never clobber a running item" and the legacy view's
    // symmetric rule, the control plane says 'blocked' while the legacy
    // entry says 'running' — the divergence AC18-13 describes.
    // The registry is stored as {version, items, sequence, updatedAt}: the
    // item lives under `items`, so THAT is the key to delete.
    const cpStore = readJson<{ items: Record<string, unknown> }>(sim.backing, 'control_plane')!
    expect(cpStore.items['acme/widgets#3']).toBeDefined()
    delete cpStore.items['acme/widgets#3']
    sim.backing.set('control_plane', JSON.stringify(cpStore))

    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)

    const after = controlPlane(sim.backing)
    const stillRunning = Object.values(after.items).filter((i) => i.status === 'running')
    expect(stillRunning).toHaveLength(1)
    expect(stillRunning[0]?.status).toBe('running')

    const status = (await rpc(sim, 'automate.controlPlaneStatus')({}, sim.registry.context)) as {
      divergences: string[]
    }
    expect(status.divergences).toEqual([])
  })

  it('the fix is idempotent: repeated scans do not drift', async () => {
    const sim = makeSim({
      issues: ISSUES,
      chain: CHAIN,
      settings: { 'ordering.dependencyPattern': '(#(\\d+))' },
    })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)

    const queue = readJson<QueueEntry[]>(sim.backing, 'queue')!
    const dependency = queue.find((e) => e.issueNumber === 3)!
    sim.closedIssues.push(3)
    await rpc(sim, 'automate.removeIssue')({ queueId: dependency.id }, sim.registry.context)

    for (let i = 0; i < 5; i += 1) {
      await rpc(sim, 'automate.scanNow')({}, sim.registry.context)
      const status = (await rpc(sim, 'automate.controlPlaneStatus')({}, sim.registry.context)) as {
        divergences: string[]
      }
      expect(status.divergences).toEqual([])
    }
  })
})

describe('AC18-24 — the token budget applies to the single-issue path too', () => {
  it('refuses to start an issue that already exceeded its budget', async () => {
    const sim = makeSim({
      issues: ISSUES,
      chain: CHAIN,
      settings: { 'budget.maxTokensPerIssue': 100, 'ordering.dependencyPattern': '(#(\\d+))' },
    })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)

    // The issue already consumed more than its budget. Issue #3 is the one
    // with no dependency, so it is the one the budget applies to.
    const cpStore = readJson<{ items: Record<string, { tokens: { totalTokens: number } }> }>(
      sim.backing,
      'control_plane',
    )!
    cpStore.items['acme/widgets#3']!.tokens.totalTokens = 500
    sim.backing.set('control_plane', JSON.stringify(cpStore))

    const queue = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
    const target = queue.find((e) => e.issueNumber === 3)!
    await expect(
      rpc(sim, 'automate.startIssue')({ queueId: target.id }, sim.registry.context),
    ).rejects.toThrow(/token budget exceeded/)

    // No session was created, and the two views agree on the block.
    expect(sim.sessions).toHaveLength(0)
    const after = controlPlane(sim.backing)
    expect(after.items['acme/widgets#3']?.status).toBe('blocked')

    const status = (await rpc(sim, 'automate.controlPlaneStatus')({}, sim.registry.context)) as {
      divergences: string[]
    }
    expect(status.divergences).toEqual([])
  })
})
