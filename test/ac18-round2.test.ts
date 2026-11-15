/**
 * AC18 — regression tests for the defects found by the SECOND
 * independent verification round.
 *
 *   E1 — the session creation did NOT use the orchestration port, so the
 *        plugin had no working session path on a real host (which exposes
 *        neither `context.host` nor `context.openFoxInternals`).
 *
 *   E2 — `automate.startIssue` still used the BULK reservation, which
 *        left the other issues 'reserved' with no session.
 *
 *   E3 — a dry-run pass reserved the issues and then discarded them, so
 *        turning the dry run off left the queue blocked by orphans.
 *
 *   E4 — the spawn-failure path wrote only the legacy entry, leaving the
 *        control plane 'reserved' (a drift and an orphan).
 *
 * Everything is offline: a fake GitHub and a fake host HTTP API, both
 * provided by the SHARED harness (`test/helpers/sim.ts`).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { _resetLifecycleForTesting, register } from '../src/index.js'
import { CONTROL_PLANE_STORAGE_KEY } from '../src/control-plane-store.js'
import { makeSim, readJson, rpc, settle } from './helpers/sim.js'
import type { QueueEntry } from '../src/types.js'

function controlPlane(backing: Map<string, unknown>): {
  items: Record<string, { key: string; status: string; sessionId?: string; error?: string }>
} {
  return (
    readJson<{
      items: Record<string, { key: string; status: string; sessionId?: string; error?: string }>
    }>(backing, CONTROL_PLANE_STORAGE_KEY) ?? { items: {} }
  )
}

afterEach(() => {
  _resetLifecycleForTesting()
  vi.unstubAllGlobals()
})

describe('AC18 E1 — the session is created through the supported HTTP API', () => {
  it('creates the session on the real host (no context.host) and launches the workflow', async () => {
    const sim = makeSim({ issues: [{ number: 1, title: 'I1' }] })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)

    const result = (await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)) as {
      started: number
    }

    // The session went through the host's HTTP API.
    expect(result.started).toBe(1)
    expect(sim.sessions).toHaveLength(1)
    expect(sim.hostCalls.some((c) => c.method === 'POST' && c.url.endsWith('/api/sessions'))).toBe(true)
    // And the workflow was launched through the host's task board, which
    // is the only HTTP path where the host resolves the workflow id.
    expect(sim.launchedPrompts[0]).toContain('/plan-issue-v3')
    expect(
      sim.hostCalls.some(
        (c) => c.method === 'POST' && c.url.includes('/api/projects/') && c.url.endsWith('/tasks'),
      ),
    ).toBe(true)
    expect(controlPlane(sim.backing).items['acme/widgets#1']?.status).toBe('running')
  })
})

describe('AC18 E2 — startIssue reserves only its own issue', () => {
  it('leaves no orphan reservation behind', async () => {
    const sim = makeSim({
      issues: Array.from({ length: 10 }, (_, i) => ({ number: i + 1, title: `I${i + 1}` })),
    })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)

    const queue = readJson<QueueEntry[]>(sim.backing, 'queue')!
    await rpc(sim, 'automate.startIssue')({ queueId: queue[0]!.id }, sim.registry.context)

    const cp = controlPlane(sim.backing)
    // Exactly ONE issue is taken (the one being started) and it has a
    // session; the other nine stay 'queued'. The decisive property is
    // that NO item is left 'reserved' without a session.
    expect(Object.values(cp.items).filter((i) => i.status === 'reserved')).toHaveLength(0)
    expect(Object.values(cp.items).filter((i) => i.status === 'running')).toHaveLength(1)
    expect(Object.values(cp.items).filter((i) => i.status === 'queued')).toHaveLength(9)
    expect(Object.values(cp.items).find((i) => i.status === 'running')?.sessionId).toBeTruthy()

    // And the queue still drains: the schedule pass can pick the others up.
    await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)
    expect(sim.sessions.length).toBeGreaterThan(1)
  })
})

describe('AC18 E3 — a dry run reserves nothing', () => {
  it('leaves no orphan reservation that would block the queue afterwards', async () => {
    const sim = makeSim({ issues: [{ number: 1, title: 'I1' }], settings: { dryRun: true } })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)

    const result = (await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)) as {
      started: number
    }
    expect(result.started).toBe(0)
    expect(sim.sessions).toHaveLength(0)

    // No reservation was left behind.
    const cp = controlPlane(sim.backing)
    expect(Object.values(cp.items).filter((i) => i.status === 'reserved')).toHaveLength(0)
  })
})

describe('AC18 E4 — the spawn failure updates the control plane', () => {
  it('keeps the two views in agreement when the host refuses the session', async () => {
    const sim = makeSim({ issues: [{ number: 1, title: 'I1' }], hostReachable: false })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)

    await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)

    const cp = controlPlane(sim.backing)
    expect(cp.items['acme/widgets#1']?.status).toBe('failed')
    // No orphan reservation is left, and the legacy entry agrees.
    expect(Object.values(cp.items).filter((i) => i.status === 'reserved')).toHaveLength(0)

    const status = (await rpc(sim, 'automate.controlPlaneStatus')({}, sim.registry.context)) as {
      divergences: string[]
    }
    expect(status.divergences).toEqual([])
  })
})
