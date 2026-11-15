/**
 * AC18-22 — The control plane must never hold an item the legacy queue
 * lacks, and a dependency cycle must be blocked in BOTH views.
 *
 *   (a) `automate.controlPlaneSchedule` built a fallback queue entry but
 *       called `store.update()` on it, which THROWS when the id is not in
 *       the active queue — so the issue was marked 'failed' with the
 *       cryptic 'Queue entry not found'.
 *
 *   (b) `topologicalSort` returns the cycle entries separately, and the
 *       legacy view was built from the ordered list alone — so the cycle
 *       entries were DROPPED from the queue while the control plane still
 *       held them as 'queued'.
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

describe('AC18-22 — the control plane never holds an item the queue lacks', () => {
  it('(a) adds the missing legacy entry instead of failing with "Queue entry not found"', async () => {
    const sim = makeSim({ issues: [{ number: 1, title: 'I1' }] })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)

    // The control plane knows an issue the legacy queue does not (the
    // registry survived, the queue was cleared).
    const cp = controlPlane(sim.backing)
    cp.items['acme/widgets#9'] = {
      key: 'acme/widgets#9',
      repoKey: 'acme/widgets',
      projectId: 'proj-1',
      issueNumber: 9,
      title: 'Orphan',
      url: '',
      status: 'queued',
      priority: 0,
      dependsOn: [],
      attempt: 0,
      tokens: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedPromptTokens: 0,
        cacheWriteTokens: 0,
        llmCalls: 0,
      },
      updatedAt: new Date().toISOString(),
    }
    sim.backing.set(CONTROL_PLANE_STORAGE_KEY, JSON.stringify(cp))

    const result = (await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)) as {
      started: number
    }

    // The missing entry was ADDED, so the scheduler could start it —
    // instead of failing with 'Queue entry not found'.
    expect(result.started).toBeGreaterThanOrEqual(1)
    expect(sim.sessions).toHaveLength(result.started)

    const queue = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
    expect(queue.some((e) => e.issueNumber === 9)).toBe(true)
    // And the orphan is not stuck 'failed' with the cryptic error.
    expect(controlPlane(sim.backing).items['acme/widgets#9']?.status).not.toBe('failed')
  })

  it('(b) keeps the dependency-cycle entries in BOTH views, blocked', async () => {
    // #4 depends on #5 and #5 depends on #4: a cycle.
    const sim = makeSim({
      issues: [
        { number: 4, title: 'D', body: 'Depends on #5' },
        { number: 5, title: 'E', body: 'Depends on #4' },
      ],
      settings: {
        'ordering.strategy': 'strict-deps',
        'ordering.dependencyPattern': '(#(\\d+))',
      },
    })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)

    // The cycle entries are NOT dropped from the legacy queue…
    const queue = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
    expect(queue).toHaveLength(2)
    for (const entry of queue) {
      expect(entry.status).toBe('blocked')
    }

    // …and the control plane agrees.
    const cp = controlPlane(sim.backing)
    expect(cp.items['acme/widgets#4']?.status).toBe('blocked')
    expect(cp.items['acme/widgets#5']?.status).toBe('blocked')

    // The scheduler does not start them.
    const result = (await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)) as {
      started: number
    }
    expect(result.started).toBe(0)
    expect(sim.sessions).toHaveLength(0)

    const status = (await rpc(sim, 'automate.controlPlaneStatus')({}, sim.registry.context)) as {
      divergences: string[]
    }
    expect(status.divergences).toEqual([])
  })
})
