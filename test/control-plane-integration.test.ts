/**
 * AC11 / AC12 — integration of the durable control plane into the plugin.
 *
 * The control plane is exercised through the plugin's public surface
 * (RPCs and hooks) so the wiring is proven, not just the pure functions.
 * Everything is offline: the shared harness (`test/helpers/sim.ts`) fakes
 * GitHub and the host — no server, no port.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { _resetLifecycleForTesting, register } from '../src/index.js'
import { CONTROL_PLANE_STORAGE_KEY } from '../src/control-plane-store.js'
import { makeSim, readJson, rpc, settle } from './helpers/sim.js'
import type { QueueEntry } from '../src/types.js'

const CHAIN = ['plan-issue-v3', 'build-verify-v3', 'publish-pr-v1']

function controlPlaneOf(backing: Map<string, unknown>): {
  items: Record<
    string,
    { status: string; sessionId?: string; tokens: { totalTokens: number; cachedPromptTokens: number } }
  >
} {
  const raw = backing.get(CONTROL_PLANE_STORAGE_KEY)
  return raw === undefined ? { items: {} } : (JSON.parse(raw as string) as never)
}

afterEach(() => {
  _resetLifecycleForTesting()
  vi.unstubAllGlobals()
})

describe('AC11 — durable control plane', () => {
  it('admits scanned issues into the durable registry', async () => {
    const sim = makeSim({
      issues: [
        { number: 1, title: 'Issue 1', labels: ['bug'] },
        { number: 2, title: 'Issue 2' },
      ],
      chain: CHAIN,
      inProcessFacade: true,
    })
    register(sim.registry)
    await settle()

    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)

    const registry = controlPlaneOf(sim.backing)
    expect(Object.keys(registry.items).sort()).toEqual(['acme/widgets#1', 'acme/widgets#2'])
    expect(registry.items['acme/widgets#1']?.status).toBe('queued')
  })

  it('reserves exclusively and never exceeds the worker ceiling', async () => {
    const sim = makeSim({
      issues: Array.from({ length: 7 }, (_, i) => ({ number: i + 1, title: `Issue ${i + 1}` })),
      chain: CHAIN,
      inProcessFacade: true,
    })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)

    const first = (await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)) as {
      started: number
    }
    // The ceiling is 5 workers.
    expect(first.started).toBe(5)

    const registry = controlPlaneOf(sim.backing)
    const running = Object.values(registry.items).filter((i) => i.status === 'running')
    expect(running).toHaveLength(5)

    // A second pass finds nothing left to reserve (exclusive reservation).
    const second = (await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)) as {
      started: number
    }
    expect(second.started).toBe(0)
  })

  it('persists the registry under a single storage key (atomic round-trip)', async () => {
    const sim = makeSim({ issues: [{ number: 1, title: 'Issue 1' }], chain: CHAIN })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)

    // The registry lives under ONE key, so its read-modify-write never
    // races another key's write.
    const keys = [...sim.backing.keys()]
    expect(keys).toContain(CONTROL_PLANE_STORAGE_KEY)
    expect(typeof sim.backing.get(CONTROL_PLANE_STORAGE_KEY)).toBe('string')
  })

  it('attributes the token usage reported by the host to the running issue', async () => {
    const sim = makeSim({
      issues: [{ number: 1, title: 'Issue 1' }],
      chain: CHAIN,
      inProcessFacade: true,
    })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)
    await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)
    await settle()

    const registry = controlPlaneOf(sim.backing)
    const item = registry.items['acme/widgets#1']
    expect(item?.status).toBe('running')
    const sessionId = item?.sessionId
    expect(sessionId).toBeTruthy()

    await sim.calls.hook
      .find((h) => h.h === 'llm.completed')!
      .fn({
        event: 'llm.completed',
        timestamp: new Date().toISOString(),
        sessionId,
        data: {
          providerId: 'p',
          model: 'm',
          promptTokens: 1000,
          completionTokens: 200,
          totalTokens: 1200,
          cachedPromptTokens: 600,
          cacheWriteTokens: 50,
        },
      })

    const after = controlPlaneOf(sim.backing)
    expect(after.items['acme/widgets#1']?.tokens.totalTokens).toBe(1200)
    expect(after.items['acme/widgets#1']?.tokens.cachedPromptTokens).toBe(600)
  })

  it('exposes the control-plane metrics through an RPC', async () => {
    const sim = makeSim({ issues: [], chain: CHAIN })
    register(sim.registry)
    await settle()

    const status = (await rpc(sim, 'automate.controlPlaneStatus')({}, sim.registry.context)) as {
      options: { maxWorkers: number }
      metrics: { maxWorkers: number; activeWorkers: number }
      items: unknown[]
    }
    expect(status.options.maxWorkers).toBe(5)
    expect(status.metrics.maxWorkers).toBe(5)
    expect(status.metrics.activeWorkers).toBe(0)
    expect(status.items).toEqual([])
  })

  it('caps the worker count at 5 even when the settings ask for more', async () => {
    const sim = makeSim({
      issues: [],
      chain: CHAIN,
      settings: { 'batch.maxConcurrency': 50, 'batch.maxConcurrencyPerRepo': 50 },
    })
    register(sim.registry)
    await settle()

    const status = (await rpc(sim, 'automate.controlPlaneStatus')({}, sim.registry.context)) as {
      options: { maxWorkers: number; maxWorkersPerRepo: number }
    }
    expect(status.options.maxWorkers).toBe(5)
    expect(status.options.maxWorkersPerRepo).toBe(5)
  })
})

describe('AC12 — the host mechanisms are reused, not duplicated', () => {
  it('does not introduce a second state machine: the chain engine is untouched', async () => {
    // The plugin still drives ONE workflow per chain step through the host.
    // The control plane only decides what runs; it never advances a chain.
    const sim = makeSim({
      issues: [{ number: 1, title: 'Issue 1' }],
      chain: CHAIN,
      inProcessFacade: true,
    })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)
    await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)
    await settle()

    // The scheduler reserved the issue and delegated to the CHAIN ENGINE:
    // exactly ONE workflow is launched, and it is the first step of the
    // chain. The control plane does not run a workflow of its own — it
    // reuses the existing engine (regression: the scheduler used to create
    // a session directly, producing a session the chain engine could never
    // see, and the legacy path could then start a SECOND session for the
    // same issue).
    expect(sim.inProcessLaunches).toHaveLength(1)
    expect(sim.inProcessLaunches[0]?.workflowId).toBe('plan-issue-v3')
    expect(controlPlaneOf(sim.backing).items['acme/widgets#1']?.status).toBe('running')
  })

  it('keeps the workflow launch in the chain engine (host event drives the next step)', async () => {
    const sim = makeSim({
      issues: [{ number: 1, title: 'Issue 1' }],
      chain: CHAIN,
      inProcessFacade: true,
    })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)

    // The legacy queue path still launches the chain.
    const queued = readJson<QueueEntry[]>(sim.backing, 'queue')!
    await rpc(sim, 'automate.startIssue')({ queueId: queued[0]!.id }, sim.registry.context)
    await settle()

    expect(sim.inProcessLaunches).toHaveLength(1)
    expect(sim.inProcessLaunches[0]?.workflowId).toBe('plan-issue-v3')
  })
})
