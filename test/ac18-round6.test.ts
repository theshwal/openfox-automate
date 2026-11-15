/**
 * AC18 — regression tests for the defects found by the SIXTH verification
 * round.
 *
 *   I1 — a completed issue was re-queued by the next scan, so the legacy
 *        path started a SECOND session for it.
 *
 *   I2 — `automate.reprocess` reset the issue to 'queued' WITHOUT applying
 *        the dependency gate, so the two views diverged.
 *
 *   I3 — a block raised AT RESERVATION (the token budget) was never
 *        mirrored to the legacy queue.
 *
 *   I4 — `automate.reprocess` started a second live session when the host
 *        refused to stop the previous one (fail-open).
 *
 * Everything is offline: the shared harness (`test/helpers/sim.ts`).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { _resetLifecycleForTesting, register } from '../src/index.js'
import { CONTROL_PLANE_STORAGE_KEY } from '../src/control-plane-store.js'
import { makeSim, readJson, rpc, settle } from './helpers/sim.js'
import type { QueueEntry } from '../src/types.js'

function controlPlane(backing: Map<string, unknown>): {
  items: Record<string, { key: string; status: string; sessionId?: string; error?: string; tokens?: unknown }>
} {
  return (
    readJson<{
      items: Record<
        string,
        { key: string; status: string; sessionId?: string; error?: string; tokens?: unknown }
      >
    }>(backing, CONTROL_PLANE_STORAGE_KEY) ?? { items: {} }
  )
}

afterEach(() => {
  _resetLifecycleForTesting()
  vi.unstubAllGlobals()
})

describe('AC18 I1 — a completed issue is not re-run by the next scan', () => {
  it('does not re-add it and does not create a second session', async () => {
    const sim = makeSim({ issues: [{ number: 1, title: 'I1' }], chain: ['plan-issue-v3'] })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)
    await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)
    expect(sim.sessions).toHaveLength(1)

    // The issue completes.
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

    // The next scan must not re-queue it.
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)
    expect(readJson<QueueEntry[]>(sim.backing, 'queue')).toHaveLength(0)
    expect(readJson<QueueEntry[]>(sim.backing, 'history')).toHaveLength(1)

    // And the legacy path must not start it again.
    await sim.calls.hook.find((h) => h.h === 'task.completed')!.fn({})
    expect(sim.sessions).toHaveLength(1)

    const status = (await rpc(sim, 'automate.controlPlaneStatus')({}, sim.registry.context)) as {
      divergences: string[]
    }
    expect(status.divergences).toEqual([])
  })
})

describe('AC18 I2 — reprocess applies the dependency gate in both views', () => {
  it('leaves the issue blocked everywhere', async () => {
    const sim = makeSim({
      issues: [{ number: 2, title: 'B', body: 'Depends on #3' }],
      chain: ['plan-issue-v3'],
      settings: { 'ordering.dependencyPattern': '(#(\\d+))' },
    })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)

    const queue = readJson<QueueEntry[]>(sim.backing, 'queue')!
    await rpc(sim, 'automate.reprocess')({ queueId: queue[0]!.id }, sim.registry.context)

    expect(controlPlane(sim.backing).items['acme/widgets#2']?.status).toBe('blocked')
    expect(readJson<QueueEntry[]>(sim.backing, 'queue')?.[0]?.status).toBe('blocked')

    const status = (await rpc(sim, 'automate.controlPlaneStatus')({}, sim.registry.context)) as {
      divergences: string[]
    }
    expect(status.divergences).toEqual([])
  })
})

describe('AC18 I3 — a block raised at reservation is mirrored', () => {
  it('blocks the legacy entry when the token budget is exceeded', async () => {
    const sim = makeSim({
      issues: [{ number: 1, title: 'I1' }],
      chain: ['plan-issue-v3'],
      settings: { 'budget.maxTokensPerIssue': 100 },
    })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)

    // The issue already consumed more than the budget.
    const cp = controlPlane(sim.backing)
    const item = cp.items['acme/widgets#1']
    if (!item) throw new Error('the item must exist')
    item.tokens = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 500,
      cachedPromptTokens: 0,
      cacheWriteTokens: 0,
      llmCalls: 1,
    }
    sim.backing.set(CONTROL_PLANE_STORAGE_KEY, JSON.stringify(cp))

    await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)

    expect(controlPlane(sim.backing).items['acme/widgets#1']?.status).toBe('blocked')
    expect(readJson<QueueEntry[]>(sim.backing, 'queue')?.[0]?.status).toBe('blocked')

    const status = (await rpc(sim, 'automate.controlPlaneStatus')({}, sim.registry.context)) as {
      divergences: string[]
    }
    expect(status.divergences).toEqual([])
  })
})

describe('AC18 I4 — the reprocess fails closed when the session cannot be stopped', () => {
  it('does not start a second live session', async () => {
    const sim = makeSim({
      issues: [{ number: 1, title: 'I1' }],
      chain: ['plan-issue-v3'],
      stopFails: true,
    })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)
    await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)
    expect(sim.sessions).toHaveLength(1)

    const queue = readJson<QueueEntry[]>(sim.backing, 'queue')!
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

    // The host refuses to stop the previous session: the reprocess must
    // refuse rather than create a second live session.
    await expect(
      rpc(sim, 'automate.reprocess')({ queueId: queue[0]!.id }, sim.registry.context),
    ).rejects.toThrow(/could not be stopped/)

    expect(sim.stopCalls.length).toBeGreaterThanOrEqual(1)
    expect(sim.sessions).toHaveLength(1)
  })
})
