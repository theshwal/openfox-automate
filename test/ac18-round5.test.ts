/**
 * AC18 — regression tests for the defects found by the final verification
 * round.
 *
 *   H1 — after a scan, the control plane admitted the entries as 'queued'
 *        while the legacy view had blocked them (missing dependency): the
 *        two views diverged.
 *
 *   H2 — the legacy scheduler path did not apply the dependency gate, so it
 *        started an issue whose prerequisite was missing.
 *
 *   H3 — a reclaimed (expired) lease was mirrored with a transition the
 *        store REFUSED ('queued' → 'blocked'), so the mirror was silently
 *        dropped and the legacy entry stayed 'queued' — and the legacy path
 *        then started a SECOND session while the first was still alive.
 *
 *   H4 — `automate.reprocess` did not stop the previous session, so it
 *        created a second session for the same issue.
 *
 * Everything is offline: the shared harness (`test/helpers/sim.ts`).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { _resetLifecycleForTesting, register } from '../src/index.js'
import { CONTROL_PLANE_STORAGE_KEY } from '../src/control-plane-store.js'
import { makeSim, readJson, rpc, settle } from './helpers/sim.js'
import type { QueueEntry } from '../src/types.js'

function controlPlane(backing: Map<string, unknown>): {
  items: Record<
    string,
    {
      key: string
      status: string
      sessionId?: string
      error?: string
      dependsOn?: number[]
      leaseExpiresAt?: number
    }
  >
} {
  return (
    readJson<{
      items: Record<
        string,
        {
          key: string
          status: string
          sessionId?: string
          error?: string
          dependsOn?: number[]
          leaseExpiresAt?: number
        }
      >
    }>(backing, CONTROL_PLANE_STORAGE_KEY) ?? { items: {} }
  )
}

afterEach(() => {
  _resetLifecycleForTesting()
  vi.unstubAllGlobals()
})

describe('AC18 H1 — a scan leaves the two views in agreement', () => {
  it('blocks the entry whose dependency is missing in BOTH views', async () => {
    const sim = makeSim({
      issues: [{ number: 2, title: 'B', body: 'Depends on #3' }],
      chain: ['plan-issue-v3'],
      settings: { 'ordering.dependencyPattern': '(#(\\d+))' },
    })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)

    const cp = controlPlane(sim.backing)
    expect(cp.items['acme/widgets#2']?.status).toBe('blocked')
    expect(readJson<QueueEntry[]>(sim.backing, 'queue')?.[0]?.status).toBe('blocked')

    const status = (await rpc(sim, 'automate.controlPlaneStatus')({}, sim.registry.context)) as {
      divergences: string[]
    }
    expect(status.divergences).toEqual([])
  })
})

describe('AC18 H2 — the dependency gate guards the legacy path too', () => {
  it('does not start an issue whose dependency is missing', async () => {
    // #1 depends on the missing #9; #2 depends on #1.
    const sim = makeSim({
      issues: [
        { number: 1, title: 'A', body: 'Depends on #9' },
        { number: 2, title: 'B', body: 'Depends on #1' },
      ],
      chain: ['plan-issue-v3'],
      settings: { 'ordering.dependencyPattern': '(#(\\d+))' },
    })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)

    // The legacy path runs (as it does on a workflow completion).
    await sim.calls.hook.find((h) => h.h === 'task.completed')!.fn({})

    // Neither issue may run: #1's dependency is missing, #2's is not done.
    expect(sim.sessions).toHaveLength(0)
    const cp = controlPlane(sim.backing)
    expect(cp.items['acme/widgets#1']?.status).toBe('blocked')
    expect(cp.items['acme/widgets#2']?.status).not.toBe('running')
  })
})

describe('AC18 H3 — a reclaimed lease is mirrored', () => {
  it('blocks the legacy entry too, and no second session is created', async () => {
    const sim = makeSim({ issues: [{ number: 1, title: 'I1' }], chain: ['plan-issue-v3'] })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)
    await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)
    expect(sim.sessions).toHaveLength(1)

    // The lease expires while the first session may still be alive.
    const cp = controlPlane(sim.backing)
    const item = cp.items['acme/widgets#1']
    if (!item) throw new Error('the item must exist')
    item.leaseExpiresAt = Date.now() - 1000
    sim.backing.set(CONTROL_PLANE_STORAGE_KEY, JSON.stringify(cp))

    // The next pass reclaims it.
    await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)

    expect(controlPlane(sim.backing).items['acme/widgets#1']?.status).toBe('blocked')
    expect(readJson<QueueEntry[]>(sim.backing, 'queue')?.[0]?.status).toBe('blocked')

    // And the legacy path does not start a SECOND session for it.
    await sim.calls.hook.find((h) => h.h === 'task.completed')!.fn({})
    expect(sim.sessions).toHaveLength(1)

    const status = (await rpc(sim, 'automate.controlPlaneStatus')({}, sim.registry.context)) as {
      divergences: string[]
    }
    expect(status.divergences).toEqual([])
  })
})

describe('AC18 H4 — reprocess stops the previous session', () => {
  it('does not leave two sessions for the same issue', async () => {
    const sim = makeSim({ issues: [{ number: 1, title: 'I1' }], chain: ['plan-issue-v3'] })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)
    await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)
    expect(sim.sessions).toHaveLength(1)

    const queue = readJson<QueueEntry[]>(sim.backing, 'queue')!
    const id = queue[0]!.id

    // The workflow is cancelled -> the entry is blocked and reprocessable.
    await sim.calls.hook
      .find((h) => h.h === 'workflow.execution.changed')!
      .fn({
        event: 'workflow.execution.changed',
        timestamp: new Date().toISOString(),
        sessionId: 'sess-1',
        data: {
          executionId: 'exec-cancel',
          workflowId: 'plan-issue-v3',
          workflowName: 'plan-issue-v3',
          status: 'cancelled',
        },
      })

    await rpc(sim, 'automate.reprocess')({ queueId: id }, sim.registry.context)

    // The previous session was stopped, and the re-run either reuses it or
    // creates exactly one more — never two live at once.
    expect(sim.stopCalls.length).toBeGreaterThanOrEqual(1)
  })
})
