/**
 * AC18 — regression tests for the defects found by the THIRD independent
 * verification round.
 *
 *   F1 — the host does NOT resolve a `/<workflow-id>` prompt sent to
 *        `POST /api/sessions/:id/message` into a workflow launch. The
 *        resolver (`resolveSlashLaunch`) has exactly ONE call site in the
 *        host: the TASK path (`seedSession`). The launch must therefore
 *        go through the task board.
 *
 *   F2 — the PR monitor mutated the control plane BEFORE the legacy
 *        transition; when the store refused the transition (blocked →
 *        done), the two views diverged and the error escaped as an
 *        unhandled rejection.
 *
 *   F3 — an expired lease was reclaimed in the control plane only; the
 *        legacy entry stayed 'running' forever.
 *
 * Everything is offline: the shared harness (`test/helpers/sim.ts`)
 * fakes both GitHub and the OpenFox host.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { _resetLifecycleForTesting, register } from '../src/index.js'
import { monitorPRs } from '../src/pr-monitor.js'
import { ControlPlaneStore, CONTROL_PLANE_STORAGE_KEY } from '../src/control-plane-store.js'
import { makeSim, readJson, rpc, settle } from './helpers/sim.js'
import type { QueueEntry } from '../src/types.js'

function controlPlane(backing: Map<string, unknown>): {
  items: Record<
    string,
    { key: string; status: string; sessionId?: string; error?: string; leaseExpiresAt?: number }
  >
} {
  return (
    readJson<{
      items: Record<
        string,
        { key: string; status: string; sessionId?: string; error?: string; leaseExpiresAt?: number }
      >
    }>(backing, CONTROL_PLANE_STORAGE_KEY) ?? { items: {} }
  )
}

/** A store that REFUSES the blocked → done transition, like the real one. */
function refusingStore(backing: Map<string, unknown>) {
  return {
    loadActive: async () => readJson<QueueEntry[]>(backing, 'queue') ?? [],
    transitionTo: async (id: string, next: string, patch: unknown) => {
      const active = readJson<QueueEntry[]>(backing, 'queue') ?? []
      const idx = active.findIndex((e) => e.id === id)
      if (idx < 0) throw new Error(`not found: ${id}`)
      if (active[idx]!.status === 'blocked' && next === 'done') {
        throw new Error('Invalid queue transition: blocked → done')
      }
      active[idx] = { ...active[idx]!, status: next as never, ...(patch as object) }
      backing.set('queue', JSON.stringify(active))
      return active[idx]!
    },
  }
}

afterEach(() => {
  _resetLifecycleForTesting()
  vi.unstubAllGlobals()
})

describe('AC18 F1 — the workflow launch goes through the task board', () => {
  it('never sends the launch prompt to the session-message route', async () => {
    const sim = makeSim({ issues: [{ number: 1, title: 'I1' }], chain: ['plan-issue-v3'] })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)
    await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)

    // The prompt went to the task board…
    expect(sim.launchedPrompts[0]).toContain('/plan-issue-v3')
    expect(sim.hostCalls.some((c) => c.url.includes('/api/projects/proj-1/tasks'))).toBe(true)
    // …and NEVER to the session-message route, which would deliver the
    // prompt literally and never start a workflow.
    expect(sim.hostCalls.some((c) => c.url.includes('/api/sessions/sess-1/message'))).toBe(false)
  })
})

describe('AC18 F2 — the PR monitor keeps the two views in agreement', () => {
  it('does not diverge when the legacy transition is refused', async () => {
    const sim = makeSim({ issues: [{ number: 1, title: 'I1' }], chain: ['plan-issue-v3'] })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)
    await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)

    // The issue is blocked (the store refuses blocked → done).
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

    const store = new ControlPlaneStore({
      get: async (k: string) => {
        const raw = sim.backing.get(k)
        return raw === undefined ? undefined : (JSON.parse(raw as string) as unknown)
      },
      set: async (k: string, v: unknown) => {
        sim.backing.set(k, JSON.stringify(v))
      },
    })

    // The PR is merged, but the entry is 'blocked': the store refuses
    // blocked → done. The monitor must not leave a divergence behind, and
    // must not throw.
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/pulls/')) {
        return new Response(
          JSON.stringify({
            number: 42,
            state: 'closed',
            merged: true,
            mergeable: null,
            html_url: 'https://github.com/acme/widgets/pull/42',
          }),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchStub as unknown as typeof fetch)

    await expect(
      monitorPRs({
        token: 'tok',
        store: refusingStore(sim.backing) as never,
        notify: vi.fn(),
        republish: vi.fn(),
        controlPlane: store,
      } as never),
    ).resolves.toBeDefined()

    // The control plane was NOT moved to 'done': the legacy transition
    // refused it, so the authority must not claim it happened.
    expect(controlPlane(sim.backing).items['acme/widgets#1']?.status).not.toBe('done')
  })
})

describe('AC18 F3 — a reclaimed lease is mirrored to the legacy queue', () => {
  it('blocks the legacy entry too, so the two views agree', async () => {
    const sim = makeSim({ issues: [{ number: 1, title: 'I1' }], chain: ['plan-issue-v3'] })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)
    await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)

    // The lease expires: the control plane reclaims the item.
    const cp = controlPlane(sim.backing)
    const item = cp.items['acme/widgets#1']
    expect(item?.status).toBe('running')
    if (!item) throw new Error('the item must exist')
    item.leaseExpiresAt = Date.now() - 1000
    sim.backing.set(CONTROL_PLANE_STORAGE_KEY, JSON.stringify(cp))

    // The next scheduling pass reclaims it and must mirror the block.
    await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)

    const after = controlPlane(sim.backing)
    expect(after.items['acme/widgets#1']?.status).toBe('blocked')

    const queue = readJson<QueueEntry[]>(sim.backing, 'queue')!
    expect(queue[0]?.status).toBe('blocked')

    const status = (await rpc(sim, 'automate.controlPlaneStatus')({}, sim.registry.context)) as {
      divergences: string[]
    }
    expect(status.divergences).toEqual([])
  })
})
