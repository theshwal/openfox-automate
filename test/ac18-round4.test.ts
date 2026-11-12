/**
 * AC18 — regression tests for the defects found by the code-review round.
 *
 *   G1 — the PR monitor mutated the control plane BEFORE the legacy
 *        transition; a refused transition (blocked → done) left the two
 *        views diverging and made the monitor throw.
 *
 *   G2 — the task-board launch did not pass the session id, so the host
 *        seeded a SECOND session for the same issue. Every host event of
 *        the real session was then ignored by the plugin (which looks the
 *        entry up by session id) and the chain never advanced.
 *
 *   G3 — the scan admitted the candidates with an EMPTY dependency list
 *        while the legacy view derived the real ones (`#N` references), so
 *        the two views diverged and the scheduler started an issue whose
 *        dependency was missing.
 *
 * Everything is offline: the shared harness (`test/helpers/sim.ts`).
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
    { key: string; status: string; sessionId?: string; error?: string; dependsOn?: number[] }
  >
} {
  return (
    readJson<{
      items: Record<
        string,
        { key: string; status: string; sessionId?: string; error?: string; dependsOn?: number[] }
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

describe('AC18 G1 — the PR monitor never diverges', () => {
  it('does not move the control plane when the legacy transition is refused', async () => {
    const sim = makeSim({
      issues: [{ number: 1, title: 'I1' }],
      chain: ['plan-issue-v3'],
      settings: { 'pr.monitorEnabled': true, 'ordering.dependencyPattern': '(#(\\d+))' },
    })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)
    await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)

    // The issue is blocked, and a PR URL is captured.
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
    await sim.calls.hook
      .find((h) => h.h === 'tool.completed')!
      .fn({
        event: 'tool.completed',
        timestamp: new Date().toISOString(),
        sessionId: 'sess-1',
        data: {
          messageId: 'm1',
          toolCallId: 'c1',
          result: { success: true, output: 'PR https://github.com/acme/widgets/pull/42', durationMs: 1 },
        },
      })
    expect(readJson<QueueEntry[]>(sim.backing, 'queue')?.[0]?.prUrl).toBe(
      'https://github.com/acme/widgets/pull/42',
    )

    const store = new ControlPlaneStore({
      get: async (k: string) => {
        const raw = sim.backing.get(k)
        return raw === undefined ? undefined : (JSON.parse(raw as string) as unknown)
      },
      set: async (k: string, v: unknown) => {
        sim.backing.set(k, JSON.stringify(v))
      },
    })

    // The PR is merged; the entry is 'blocked' and the store refuses
    // blocked → done. The monitor must not throw and must not claim 'done'.
    await expect(
      monitorPRs({
        token: 'tok',
        store: refusingStore(sim.backing) as never,
        notify: vi.fn(),
        republish: vi.fn(),
        controlPlane: store,
      } as never),
    ).resolves.toBeDefined()

    expect(controlPlane(sim.backing).items['acme/widgets#1']?.status).not.toBe('done')
  })
})

describe('AC18 G2 — the launch reuses the plugin session', () => {
  it('passes the session id so the host does not seed a second one', async () => {
    const sim = makeSim({
      issues: [{ number: 1, title: 'I1' }],
      chain: ['plan-issue-v3'],
      settings: { 'ordering.dependencyPattern': '(#(\\d+))' },
    })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)
    await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)

    // The launch is asynchronous: the host answers, and the plugin then
    // reacts. Give the microtasks a chance to run.
    await settle()
    // The move to in_progress carries the session the plugin created.
    const moves = sim.hostCalls.filter((c) => c.method === 'POST' && c.url.includes('/move'))
    expect(moves).toHaveLength(1)
    expect(moves[0]?.body).toMatchObject({ to: 'in_progress', sessionId: 'sess-1' })
  })
})

describe('AC18 G3 — the admission carries the derived dependencies', () => {
  it('blocks an issue whose dependency is missing, in BOTH views', async () => {
    // Issue 2 depends on issue 3, which does not exist.
    const sim = makeSim({
      issues: [{ number: 2, title: 'B', body: 'Depends on #3' }],
      chain: ['plan-issue-v3'],
      settings: { 'ordering.dependencyPattern': '(#(\\d+))' },
    })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)

    const cp = controlPlane(sim.backing)
    const item = cp.items['acme/widgets#2']
    // The control plane knows the dependency…
    expect(item?.dependsOn).toEqual([3])
    // …and the legacy view blocks the entry.
    expect(readJson<QueueEntry[]>(sim.backing, 'queue')?.[0]?.status).toBe('blocked')

    // The scheduler must NOT start it.
    const result = (await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)) as {
      started: number
    }
    expect(result.started).toBe(0)

    // And the two views agree.
    const status = (await rpc(sim, 'automate.controlPlaneStatus')({}, sim.registry.context)) as {
      divergences: string[]
    }
    expect(status.divergences).toEqual([])
  })
})

describe('AC18 G4 — the budget block and the removal are mirrored', () => {
  it('mirrors the token-budget block to the legacy entry', async () => {
    const sim = makeSim({
      issues: [{ number: 1, title: 'I1' }],
      chain: ['plan-issue-v3'],
      settings: { 'budget.maxTokensPerIssue': 1000, 'ordering.dependencyPattern': '(#(\\d+))' },
    })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)
    await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)

    // The host reports the token usage of the run.
    await sim.calls.hook
      .find((h) => h.h === 'llm.completed')!
      .fn({
        event: 'llm.completed',
        timestamp: new Date().toISOString(),
        sessionId: 'sess-1',
        data: { promptTokens: 900, completionTokens: 200, totalTokens: 1100 },
      })

    // Both views are blocked.
    expect(controlPlane(sim.backing).items['acme/widgets#1']?.status).toBe('blocked')
    expect(readJson<QueueEntry[]>(sim.backing, 'queue')?.[0]?.status).toBe('blocked')

    const status = (await rpc(sim, 'automate.controlPlaneStatus')({}, sim.registry.context)) as {
      divergences: string[]
    }
    expect(status.divergences).toEqual([])
  })

  it('removes the issue from the control plane too', async () => {
    const sim = makeSim({ issues: [{ number: 1, title: 'I1' }], chain: ['plan-issue-v3'] })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)

    const queue = readJson<QueueEntry[]>(sim.backing, 'queue')!
    await rpc(sim, 'automate.removeIssue')({ queueId: queue[0]!.id }, sim.registry.context)

    expect(controlPlane(sim.backing).items['acme/widgets#1']).toBeUndefined()
    expect(readJson<QueueEntry[]>(sim.backing, 'queue')).toHaveLength(0)
  })
})
