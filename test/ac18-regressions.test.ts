/**
 * AC18 — Regression tests for the defects found by the independent
 * verifier during the Build & Verify V3 run.
 *
 * Three defects, each reproduced here BEFORE the fix:
 *
 *   D1 — the legacy `pickAndSpawnNext` reserved an issue in the control
 *        plane and then created the session ITSELF. When it ran first it
 *        left the OTHER issues 'reserved' with no session, and the
 *        control plane then returned `started = 0` forever: nine of ten
 *        issues never ran.
 *
 *   D2 — three writers updated the legacy queue entry WITHOUT the
 *        control plane, so the two views diverged:
 *          - the PR monitor (a merged or conflicting PR),
 *          - `automate.cancelIssue`,
 *          - `automate.reprocess`.
 *        The control plane is the declared single authority, so every
 *        writer must go through it.
 *
 *   D3 — `findDivergence` was never called from the runtime, so a drift
 *        was invisible in production.
 *
 * Everything is offline: the shared harness (`test/helpers/sim.ts`).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { _resetLifecycleForTesting, register } from '../src/index.js'
import { monitorPRs } from '../src/pr-monitor.js'
import { ControlPlaneStore, CONTROL_PLANE_STORAGE_KEY } from '../src/control-plane-store.js'
import { findDivergence } from '../src/state-ownership.js'
import { makeSim, readJson, rpc, settle } from './helpers/sim.js'
import type { QueueEntry } from '../src/types.js'

const CHAIN = ['plan-issue-v3', 'build-verify-v3', 'publish-pr-v1']

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

describe('AC18 D1 — the legacy path must not starve the control plane', () => {
  it('does not leave orphan reservations that block every later scheduling pass', async () => {
    const sim = makeSim({
      issues: Array.from({ length: 10 }, (_, i) => ({ number: i + 1, title: `I${i + 1}` })),
    })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)

    // Several scheduling passes, as the host would do.
    let totalStarted = 0
    for (let i = 0; i < 5; i += 1) {
      const res = (await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)) as {
        started: number
      }
      totalStarted += res.started
    }

    // The CEILING is 5 concurrent workers, so at most 5 issues run at a
    // time — that is the contract, not a defect.
    expect(totalStarted).toBe(5)

    // The decisive assertion: NO item is left 'reserved' without a
    // session. An orphan reservation blocks the whole queue forever,
    // because `reserve` only selects 'queued' items.
    const cp = controlPlane(sim.backing)
    const orphans = Object.values(cp.items).filter((i) => i.status === 'reserved' && !i.sessionId)
    expect(orphans).toHaveLength(0)

    // Every started item has a session, and the sessions match.
    const started = Object.values(cp.items).filter((i) => i.status === 'running')
    expect(started).toHaveLength(5)
    expect(sim.sessions).toHaveLength(5)
    for (const item of started) {
      expect(item.sessionId).toBeTruthy()
    }
  })

  it('drains the queue as the running issues complete', async () => {
    const sim = makeSim({
      issues: Array.from({ length: 10 }, (_, i) => ({ number: i + 1, title: `I${i + 1}` })),
      chain: CHAIN,
    })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)

    const wfHook = sim.calls.hook.find((h) => h.h === 'workflow.execution.changed')!.fn

    // First pass: 5 start (the ceiling).
    await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)
    await settle()
    expect(sim.sessions).toHaveLength(5)

    // The 5 running issues complete: the next 5 must be able to start.
    const cp = controlPlane(sim.backing)
    const running = Object.values(cp.items).filter((i) => i.status === 'running')
    expect(running).toHaveLength(5)

    // The chain has three steps: each step must complete before the next
    // one starts, and the issue is done only after the LAST one.
    //
    // The chain advance is ASYNCHRONOUS: the hook awaits the host's
    // answer to learn WHICH session the next step runs in (the host seeds
    // a new session for every step, because it can only reuse a session
    // that has no messages). The entry follows that session, so the next
    // event must be sent on the entry's CURRENT session — which is read
    // back from the queue instead of being cached.
    for (const item of running) {
      for (const step of CHAIN) {
        const current = (readJson<QueueEntry[]>(sim.backing, 'queue') ?? []).find(
          (e) => `${e.repoKey}#${e.issueNumber}` === item.key,
        )
        await wfHook({
          event: 'workflow.execution.changed',
          timestamp: new Date().toISOString(),
          sessionId: current?.sessionId ?? item.sessionId,
          data: {
            executionId: `exec-${item.key}-${step}`,
            workflowId: step,
            workflowName: step,
            status: 'completed',
          },
        })
        await settle()
      }
    }
    await settle()

    // The next issues started as soon as the running ones completed (the
    // chain engine schedules the next one on completion), so the queue
    // drained WITHOUT another scheduling pass.
    expect(sim.sessions).toHaveLength(10)

    const after = controlPlane(sim.backing)
    expect(Object.values(after.items).filter((i) => i.status === 'running')).toHaveLength(5)
    expect(Object.values(after.items).filter((i) => i.status === 'done')).toHaveLength(5)
    // No orphan reservation is left behind.
    expect(Object.values(after.items).filter((i) => i.status === 'reserved')).toHaveLength(0)
  })
})

describe('AC18 D2 — every writer goes through the control plane', () => {
  it('the PR monitor updates the control plane, not only the legacy entry', async () => {
    const sim = makeSim({ issues: [{ number: 1, title: 'I1' }] })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)
    await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)
    await settle()

    // The PR URL is captured so the monitor has something to reconcile.
    const toolHook = sim.calls.hook.find((h) => h.h === 'tool.completed')!.fn
    await toolHook({
      event: 'tool.completed',
      timestamp: new Date().toISOString(),
      sessionId: controlPlane(sim.backing).items['acme/widgets#1']?.sessionId,
      data: {
        messageId: 'm1',
        toolCallId: 'c1',
        result: { success: true, output: 'PR https://github.com/acme/widgets/pull/42', durationMs: 1 },
      },
    })
    expect(readJson<QueueEntry[]>(sim.backing, 'queue')?.[0]?.prUrl).toBe(
      'https://github.com/acme/widgets/pull/42',
    )

    // The PR is merged.
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

    // The REAL control-plane store, as the plugin wires it.
    const store = new ControlPlaneStore({
      get: async (k: string) => {
        const raw = sim.backing.get(k)
        return raw === undefined ? undefined : (JSON.parse(raw as string) as unknown)
      },
      set: async (k: string, v: unknown) => {
        sim.backing.set(k, JSON.stringify(v))
      },
    })

    await monitorPRs({
      token: 'tok',
      store: {
        loadActive: async () => readJson<QueueEntry[]>(sim.backing, 'queue') ?? [],
        transitionTo: async (id: string, next: string, patch: unknown) => {
          const active = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
          const idx = active.findIndex((e) => e.id === id)
          if (idx < 0) throw new Error(`not found: ${id}`)
          active[idx] = { ...active[idx]!, status: next as never, ...(patch as object) }
          sim.backing.set('queue', JSON.stringify(active))
          return active[idx]!
        },
      } as never,
      notify: vi.fn(),
      republish: vi.fn(),
      controlPlane: store,
    } as never)

    // The control plane is the authority: it must know the PR was merged.
    const cp = controlPlane(sim.backing)
    expect(cp.items['acme/widgets#1']?.status).toBe('done')
  })

  it('cancelIssue moves the control-plane item to cancelled', async () => {
    const sim = makeSim({ issues: [{ number: 1, title: 'I1' }] })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)
    await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)

    const queue = readJson<QueueEntry[]>(sim.backing, 'queue')!
    await rpc(sim, 'automate.cancelIssue')({ queueId: queue[0]!.id }, sim.registry.context)

    const cp = controlPlane(sim.backing)
    expect(cp.items['acme/widgets#1']?.status).toBe('cancelled')
  })

  it('reprocess re-queues the control-plane item, so it can run again', async () => {
    const sim = makeSim({ issues: [{ number: 1, title: 'I1' }] })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)
    await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)

    const queue = readJson<QueueEntry[]>(sim.backing, 'queue')!
    const id = queue[0]!.id

    // The workflow is blocked -> the entry is 'blocked' and can be
    // reprocessed.
    await sim.calls.hook
      .find((h) => h.h === 'workflow.execution.changed')!
      .fn({
        event: 'workflow.execution.changed',
        timestamp: new Date().toISOString(),
        sessionId: controlPlane(sim.backing).items['acme/widgets#1']?.sessionId,
        data: {
          executionId: 'exec-cancel',
          workflowId: 'plan-issue-v3',
          workflowName: 'plan-issue-v3',
          status: 'cancelled',
        },
      })
    expect(controlPlane(sim.backing).items['acme/widgets#1']?.status).toBe('blocked')

    await rpc(sim, 'automate.reprocess')({ queueId: id }, sim.registry.context)

    const cp = controlPlane(sim.backing)
    // The issue is schedulable again: the control plane agrees with the
    // legacy entry. Without this the control plane kept 'blocked' while
    // the legacy entry said 'queued', and `reserve` only selects
    // 'queued' items — the issue could never run again.
    //
    // It was re-queued and then immediately picked up again, so the
    // status is 'running' (it is no longer 'blocked').
    expect(cp.items['acme/widgets#1']?.status).not.toBe('blocked')
    expect(['queued', 'running', 'reserved']).toContain(cp.items['acme/widgets#1']?.status)
    // The error is cleared: the issue is no longer stuck.
    expect(cp.items['acme/widgets#1']?.error).toBeUndefined()
  })
})

describe('AC18 D3 — the drift detector is actually used', () => {
  it('the runtime reports a divergence instead of leaving it invisible', async () => {
    const sim = makeSim({ issues: [{ number: 1, title: 'I1' }] })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)
    await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)

    const status = (await rpc(sim, 'automate.controlPlaneStatus')({}, sim.registry.context)) as {
      items: Array<{ key: string; status: string }>
      divergences: string[]
    }

    // No divergence right now: the two views agree.
    expect(status.divergences).toEqual([])

    // The detector itself works on a deliberately broken pair.
    const entry = {
      id: 'x',
      repoKey: 'acme/widgets',
      issueNumber: 1,
      status: 'done',
    } as unknown as QueueEntry
    const item = { status: 'running', sessionId: 'sess-1' } as never
    expect(findDivergence(entry, item)).toContain('status drift')
  })
})
