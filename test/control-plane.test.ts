/**
 * Tests for the durable control plane (`src/control-plane.ts`).
 *
 * Pure functions over an in-memory registry: no clock dependency (the
 * `now` is injected), no network, no host.
 */

import { describe, expect, it } from 'vitest'

import {
  EMPTY_TOKEN_USAGE,
  admit,
  classifyLabels,
  computeControlPlaneMetrics,
  computePriority,
  completeItem,
  dependencyState,
  emptyControlPlaneState,
  markRunning,
  parseControlPlaneState,
  reclaimExpiredLeases,
  recordTokenUsage,
  reserve,
  DEFAULT_CONTROL_PLANE_OPTIONS,
} from '../src/control-plane.js'

const T0 = 1_700_000_000_000

function candidate(issueNumber: number, repoKey = 'acme/widgets', labels: string[] = []) {
  return {
    repoKey,
    projectId: 'proj-1',
    issueNumber,
    title: `Issue ${issueNumber}`,
    url: `https://github.com/${repoKey}/issues/${issueNumber}`,
    labels,
  }
}

describe('admission', () => {
  it('admits new items and is idempotent', () => {
    const state = emptyControlPlaneState()
    const first = admit(state, [candidate(1), candidate(2)], { now: T0 })
    expect(first.admitted).toHaveLength(2)
    expect(first.duplicates).toBe(0)

    const second = admit(state, [candidate(1), candidate(2), candidate(3)], { now: T0 })
    expect(second.admitted).toHaveLength(1)
    expect(second.duplicates).toBe(2)
    expect(Object.keys(state.items)).toHaveLength(3)
  })

  it('never rewrites the priority of an existing item', () => {
    const state = emptyControlPlaneState()
    admit(state, [candidate(1, 'acme/widgets', ['bug'])], { now: T0 })
    const priorityBefore = state.items['acme/widgets#1']!.priority
    admit(state, [candidate(1, 'acme/widgets', ['docs'])], { now: T0 })
    expect(state.items['acme/widgets#1']!.priority).toBe(priorityBefore)
  })

  it('orders bugs before features before docs before others', () => {
    expect(classifyLabels(['bug'])).toBe('bug')
    expect(classifyLabels(['enhancement'])).toBe('feature')
    // The label vocabulary matches the existing ordering module
    // (/\b(doc|documentation)\b/), so 'documentation' is the docs label.
    expect(classifyLabels(['documentation'])).toBe('docs')
    expect(classifyLabels(['chore'])).toBe('other')
    expect(computePriority(['bug'], 1)).toBeLessThan(computePriority(['feature'], 1))
    expect(computePriority(['feature'], 1)).toBeLessThan(computePriority(['documentation'], 1))
    expect(computePriority(['documentation'], 1)).toBeLessThan(computePriority(['chore'], 1))
  })

  it('keeps FIFO order inside a class', () => {
    const state = emptyControlPlaneState()
    admit(state, [candidate(1), candidate(2), candidate(3)], { now: T0 })
    const priorities = [1, 2, 3].map((n) => state.items[`acme/widgets#${n}`]!.priority)
    expect(priorities[0]!).toBeLessThan(priorities[1]!)
    expect(priorities[1]!).toBeLessThan(priorities[2]!)
  })
})

describe('dependency handling', () => {
  it('blocks an item whose dependency was never admitted', () => {
    const state = emptyControlPlaneState()
    admit(state, [{ ...candidate(2), dependsOn: [1] }], { now: T0 })
    const deps = dependencyState(state, state.items['acme/widgets#2']!)
    expect(deps.satisfied).toBe(false)
    expect(deps.missing).toEqual([1])
  })

  it('waits while the dependency is not done, and runs once it is', () => {
    const state = emptyControlPlaneState()
    admit(state, [candidate(1), { ...candidate(2), dependsOn: [1] }], { now: T0 })

    const first = reserve(state, { ...DEFAULT_CONTROL_PLANE_OPTIONS, now: T0 })
    expect(first.reserved.map((i) => i.key)).toEqual(['acme/widgets#1'])

    // #2 is not reserved: its dependency is not done.
    const second = reserve(state, { ...DEFAULT_CONTROL_PLANE_OPTIONS, now: T0 })
    expect(second.reserved.map((i) => i.key)).not.toContain('acme/widgets#2')

    completeItem(state, 'acme/widgets#1', 'done', { now: T0 })
    const third = reserve(state, { ...DEFAULT_CONTROL_PLANE_OPTIONS, now: T0 })
    expect(third.reserved.map((i) => i.key)).toContain('acme/widgets#2')
  })
})

describe('reservation and capacity', () => {
  it('never exceeds the global worker limit', () => {
    const state = emptyControlPlaneState()
    admit(
      state,
      [1, 2, 3, 4, 5, 6, 7].map((n) => candidate(n)),
      { now: T0 },
    )
    // The per-repository limit is raised explicitly: all the candidates
    // share one repository, so the default per-repo cap of 2 would mask
    // the global limit under test.
    const result = reserve(state, {
      ...DEFAULT_CONTROL_PLANE_OPTIONS,
      maxWorkers: 5,
      maxWorkersPerRepo: 5,
      now: T0,
    })
    expect(result.reserved).toHaveLength(5)
    expect(result.skipped).toHaveLength(2)
  })

  it('never exceeds the per-repository limit', () => {
    const state = emptyControlPlaneState()
    admit(
      state,
      [candidate(1, 'acme/a'), candidate(2, 'acme/a'), candidate(3, 'acme/a'), candidate(4, 'acme/b')],
      { now: T0 },
    )
    const result = reserve(state, {
      ...DEFAULT_CONTROL_PLANE_OPTIONS,
      maxWorkers: 5,
      maxWorkersPerRepo: 2,
      now: T0,
    })
    const perRepoA = result.reserved.filter((i) => i.repoKey === 'acme/a')
    expect(perRepoA).toHaveLength(2)
    expect(result.reserved.filter((i) => i.repoKey === 'acme/b')).toHaveLength(1)
  })

  it('reserves in priority order (bugs first)', () => {
    const state = emptyControlPlaneState()
    admit(
      state,
      [
        candidate(1, 'acme/a', ['docs']),
        candidate(2, 'acme/a', ['bug']),
        candidate(3, 'acme/a', ['feature']),
      ],
      { now: T0 },
    )
    const result = reserve(state, {
      ...DEFAULT_CONTROL_PLANE_OPTIONS,
      maxWorkersPerRepo: 5,
      now: T0,
    })
    expect(result.reserved.map((i) => i.issueNumber)).toEqual([2, 3, 1])
  })

  it('is exclusive: an already reserved item is not reserved twice', () => {
    const state = emptyControlPlaneState()
    admit(state, [candidate(1)], { now: T0 })
    const first = reserve(state, { ...DEFAULT_CONTROL_PLANE_OPTIONS, now: T0 })
    expect(first.reserved).toHaveLength(1)
    const second = reserve(state, { ...DEFAULT_CONTROL_PLANE_OPTIONS, now: T0 })
    expect(second.reserved).toHaveLength(0)
  })

  it('reserves at most once per call even with several candidates', () => {
    const state = emptyControlPlaneState()
    admit(state, [candidate(1), candidate(2)], { now: T0 })
    const result = reserve(state, { ...DEFAULT_CONTROL_PLANE_OPTIONS, maxWorkers: 1, now: T0 })
    expect(result.reserved).toHaveLength(1)
  })
})

describe('lease and crash recovery', () => {
  it('BLOCKS an expired lease instead of re-queueing it (no duplicate session)', () => {
    // The host session may STILL be running when the lease expires: the
    // plugin lost track of it, the host did not. Re-queueing the issue
    // would start a SECOND session for the same issue while the first one
    // is still working on it. The issue is therefore blocked and needs an
    // explicit operator decision.
    const state = emptyControlPlaneState()
    admit(state, [candidate(1), candidate(2)], { now: T0 })
    reserve(state, {
      ...DEFAULT_CONTROL_PLANE_OPTIONS,
      maxWorkersPerRepo: 5,
      leaseMs: 1000,
      now: T0,
    })

    // Before the lease expires, the slot is still held.
    const early = reserve(state, {
      ...DEFAULT_CONTROL_PLANE_OPTIONS,
      maxWorkersPerRepo: 5,
      leaseMs: 1000,
      now: T0 + 500,
    })
    expect(early.reserved).toHaveLength(0)

    // After the lease expires, the expired reservation is BLOCKED.
    const reclaimed = reclaimExpiredLeases(state, { now: T0 + 2000 })
    expect(reclaimed.length).toBeGreaterThanOrEqual(1)
    for (const item of reclaimed) {
      expect(item.status).toBe('blocked')
      expect(item.error).toContain('lease expired')
    }

    // A blocked item is never re-reserved: no duplicate session.
    const after = reserve(state, {
      ...DEFAULT_CONTROL_PLANE_OPTIONS,
      maxWorkersPerRepo: 5,
      leaseMs: 1000,
      now: T0 + 2000,
    })
    expect(after.reserved.map((i) => i.key)).not.toContain('acme/widgets#1')
  })

  it('does not reclaim a live lease', () => {
    const state = emptyControlPlaneState()
    admit(state, [candidate(1)], { now: T0 })
    reserve(state, { ...DEFAULT_CONTROL_PLANE_OPTIONS, leaseMs: 60_000, now: T0 })
    expect(reclaimExpiredLeases(state, { now: T0 + 1_000 })).toHaveLength(0)
    expect(state.items['acme/widgets#1']?.status).toBe('reserved')
  })

  it('counts the attempt on every reservation', () => {
    const state = emptyControlPlaneState()
    admit(state, [candidate(1)], { now: T0 })
    reserve(state, { ...DEFAULT_CONTROL_PLANE_OPTIONS, leaseMs: 1000, now: T0 })
    expect(state.items['acme/widgets#1']?.attempt).toBe(1)
    // After the lease expires the issue is BLOCKED (not re-queued), so it
    // is not reserved again: an operator must release it explicitly.
    reclaimExpiredLeases(state, { now: T0 + 2000 })
    reserve(state, { ...DEFAULT_CONTROL_PLANE_OPTIONS, leaseMs: 1000, now: T0 + 2000 })
    expect(state.items['acme/widgets#1']?.attempt).toBe(1)
    expect(state.items['acme/widgets#1']?.status).toBe('blocked')
  })
})

describe('budget and token accounting', () => {
  it('attributes token usage to the item that owns the session', () => {
    const state = emptyControlPlaneState()
    admit(state, [candidate(1)], { now: T0 })
    reserve(state, { ...DEFAULT_CONTROL_PLANE_OPTIONS, now: T0 })
    markRunning(state, 'acme/widgets#1', 'sess-1', { now: T0 })

    const item = recordTokenUsage(
      state,
      'sess-1',
      {
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500,
        cachedPromptTokens: 800,
        cacheWriteTokens: 100,
        llmCalls: 2,
      },
      { now: T0 },
    )
    expect(item?.tokens.totalTokens).toBe(1500)
    expect(item?.tokens.cachedPromptTokens).toBe(800)
    expect(item?.tokens.llmCalls).toBe(2)
  })

  it('ignores usage for an unknown session', () => {
    const state = emptyControlPlaneState()
    expect(recordTokenUsage(state, 'sess-unknown', { totalTokens: 10 }, { now: T0 })).toBeNull()
  })

  it('blocks a RUNNING item as soon as it exceeds its token budget', () => {
    // The budget must stop the LIVE run, not only the next reservation.
    const state = emptyControlPlaneState()
    admit(state, [candidate(1)], { now: T0 })
    reserve(state, { ...DEFAULT_CONTROL_PLANE_OPTIONS, now: T0 })
    markRunning(state, 'acme/widgets#1', 'sess-1', { now: T0 })

    recordTokenUsage(state, 'sess-1', { totalTokens: 5000 }, { now: T0, maxTokensPerIssue: 1000 })

    expect(state.items['acme/widgets#1']?.status).toBe('blocked')
    expect(state.items['acme/widgets#1']?.error).toContain('token budget')
  })

  it('does not block on the budget when it is unlimited', () => {
    const state = emptyControlPlaneState()
    admit(state, [candidate(1)], { now: T0 })
    reserve(state, { ...DEFAULT_CONTROL_PLANE_OPTIONS, now: T0 })
    markRunning(state, 'acme/widgets#1', 'sess-1', { now: T0 })
    recordTokenUsage(state, 'sess-1', { totalTokens: 500_000 }, { now: T0, maxTokensPerIssue: 0 })

    expect(state.items['acme/widgets#1']?.status).toBe('running')
  })
})

describe('metrics', () => {
  it('reports the worker usage and the cache ratio', () => {
    const state = emptyControlPlaneState()
    admit(state, [candidate(1), candidate(2)], { now: T0 })
    reserve(state, { ...DEFAULT_CONTROL_PLANE_OPTIONS, now: T0 })
    markRunning(state, 'acme/widgets#1', 'sess-1', { now: T0 })
    recordTokenUsage(
      state,
      'sess-1',
      { promptTokens: 1000, totalTokens: 1200, cachedPromptTokens: 250 },
      { now: T0 },
    )
    completeItem(state, 'acme/widgets#2', 'done', { now: T0 })

    const metrics = computeControlPlaneMetrics(state, { maxWorkers: 5 })
    expect(metrics.total).toBe(2)
    expect(metrics.activeWorkers).toBe(1)
    expect(metrics.done).toBe(1)
    expect(metrics.totalTokens).toBe(1200)
    expect(metrics.cacheHitRatio).toBeCloseTo(0.25, 5)
    expect(metrics.maxWorkers).toBe(5)
    expect(metrics.perItem).toHaveLength(2)
  })
})

describe('durability', () => {
  it('round-trips through JSON (the host stores JSON strings)', () => {
    const state = emptyControlPlaneState()
    admit(state, [candidate(1, 'acme/a', ['bug'])], { now: T0 })
    reserve(state, { ...DEFAULT_CONTROL_PLANE_OPTIONS, now: T0 })
    const restored = parseControlPlaneState(JSON.parse(JSON.stringify(state)))
    expect(Object.keys(restored.items)).toEqual(['acme/a#1'])
    expect(restored.items['acme/a#1']?.status).toBe('reserved')
    expect(restored.sequence).toBe(state.sequence)
  })

  it('tolerates a corrupted payload instead of crashing', () => {
    expect(parseControlPlaneState(null).items).toEqual({})
    expect(parseControlPlaneState('garbage').items).toEqual({})
    expect(parseControlPlaneState({ version: 1 }).items).toEqual({})
    expect(parseControlPlaneState({ version: 1, items: 'nope' }).items).toEqual({})
    expect(parseControlPlaneState({ version: 1, items: { a: 'not-an-object' } }).items).toEqual({})
  })

  it('starts with an empty, zero-token registry', () => {
    const state = emptyControlPlaneState()
    expect(state.items).toEqual({})
    expect(state.sequence).toBe(0)
    expect(state.items['x']?.tokens ?? EMPTY_TOKEN_USAGE).toEqual(EMPTY_TOKEN_USAGE)
  })
})
