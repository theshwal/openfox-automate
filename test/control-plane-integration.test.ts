/**
 * AC11 / AC12 — integration of the durable control plane into the plugin.
 *
 * The control plane is exercised through the plugin's public surface
 * (RPCs and hooks) so the wiring is proven, not just the pure functions.
 * Everything is offline: a fake GitHub, a fake host, no server.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { _resetLifecycleForTesting, register } from '../src/index.js'
import { CONTROL_PLANE_STORAGE_KEY } from '../src/control-plane-store.js'
import type { PluginContext, PluginRegistry } from 'openfox/plugin'
import type { QueueEntry } from '../src/types.js'

interface Hook {
  h: string
  fn: (p: unknown) => Promise<void>
}

const CHAIN = ['plan-issue-v3', 'build-verify-v3', 'publish-pr-v1']

function makeSim(): {
  registry: PluginRegistry
  calls: { hook: Hook[]; rpc: Array<{ name: string; fn: (p: unknown, c: unknown) => Promise<unknown> }> }
  backing: Map<string, unknown>
  launched: Array<{ sessionId: string; workflowId: string }>
} {
  const calls: {
    hook: Hook[]
    rpc: Array<{ name: string; fn: (p: unknown, c: unknown) => Promise<unknown> }>
  } = { hook: [], rpc: [] }
  const backing = new Map<string, unknown>()
  const launched: Array<{ sessionId: string; workflowId: string }> = []

  const context = {
    id: 'openfox-automate',
    version: '0.1.0',
    runtime: { mode: 'development' as const, configDirectory: '/tmp/openfox-cp' },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    storage: {
      get: vi.fn(async (k: string) => {
        const raw = backing.get(k)
        return raw === undefined ? undefined : (JSON.parse(raw as string) as unknown)
      }),
      set: vi.fn(async (k: string, v: unknown) => {
        backing.set(k, JSON.stringify(v))
      }),
    },
    settings: vi.fn(() => ({
      'github.token': 'tok',
      'repos.mapping': 'acme/widgets=proj-1',
      'workflows.chain': CHAIN.join('\n'),
      'scan.startupScan': false,
      'scan.ignoreLabels': '',
      'batch.maxConcurrency': 5,
      'batch.maxConcurrencyPerRepo': 5,
      'ordering.strategy': 'default',
      'ordering.dependencyPattern': '',
      dryRun: false,
      'history.retentionCount': 100,
      'post.closeOnSuccess': false,
      'post.assignOnSuccess': false,
      'post.commentTemplate': '',
      'post.reprocessResetsRetryCount': true,
      'pr.monitorEnabled': false,
      'pr.urlRegex': '',
      'budget.maxTokensPerIssue': 0,
      'control.leaseMinutes': 10,
    })),
    notify: vi.fn(),
    publish: vi.fn(),
  } as unknown as PluginContext

  const registry = {
    context,
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerSkillSource: vi.fn(),
    registerSettings: vi.fn(),
    registerUiAction: vi.fn(),
    registerUiBadge: vi.fn(),
    registerUiPanel: vi.fn(),
    registerHook: (h: string, fn: (p: unknown) => Promise<void>) => calls.hook.push({ h, fn }),
    registerTransitionHandler: vi.fn(),
    registerRpc: (name: string, fn: (p: unknown, c: unknown) => Promise<unknown>) =>
      calls.rpc.push({ name, fn }),
    registerAsset: vi.fn(),
    registerAuth: vi.fn(),
    registerTransport: vi.fn(),
    registerPreset: vi.fn(),
    registerModelMetadataProvider: vi.fn(),
  } as unknown as PluginRegistry

  ;(context as unknown as { host?: unknown }).host = {
    sessions: {
      create: async () => ({ sessionId: `sess-${launched.length + 1}`, workdir: '/tmp/sim' }),
      stop: vi.fn(),
    },
    workflows: {
      launch: (p: { sessionId: string; workflowId: string }) => {
        launched.push({ sessionId: p.sessionId, workflowId: p.workflowId })
      },
    },
  }

  return { registry, calls, backing, launched }
}

function hookOf(sim: ReturnType<typeof makeSim>, event: string): (p: unknown) => Promise<void> {
  const found = sim.calls.hook.find((h) => h.h === event)
  if (!found) throw new Error(`hook not registered: ${event}`)
  return found.fn
}

function controlPlaneOf(sim: ReturnType<typeof makeSim>): {
  items: Record<
    string,
    { status: string; sessionId?: string; tokens: { totalTokens: number; cachedPromptTokens: number } }
  >
} {
  const raw = sim.backing.get(CONTROL_PLANE_STORAGE_KEY)
  return raw === undefined ? { items: {} } : (JSON.parse(raw as string) as never)
}

function issuePayload(number: number, labels: string[] = []): Record<string, unknown> {
  return {
    number,
    title: `Issue ${number}`,
    body: '',
    html_url: `https://github.com/acme/widgets/issues/${number}`,
    state: 'open',
    labels: labels.map((name) => ({ name })),
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    user: { login: 'r' },
  }
}

afterEach(() => {
  _resetLifecycleForTesting()
  vi.unstubAllGlobals()
})

describe('AC11 — durable control plane', () => {
  it('admits scanned issues into the durable registry', async () => {
    const sim = makeSim()
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/issues?')) {
        return new Response(JSON.stringify([issuePayload(1, ['bug']), issuePayload(2)]), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchStub as unknown as typeof fetch)

    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))

    await sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!.fn({}, sim.registry.context)

    const registry = controlPlaneOf(sim)
    expect(Object.keys(registry.items).sort()).toEqual(['acme/widgets#1', 'acme/widgets#2'])
    expect(registry.items['acme/widgets#1']?.status).toBe('queued')
  })

  it('reserves exclusively and never exceeds the worker ceiling', async () => {
    const sim = makeSim()
    const issues = [1, 2, 3, 4, 5, 6, 7].map((n) => issuePayload(n))
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/issues?')) {
        return new Response(JSON.stringify(issues), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchStub as unknown as typeof fetch)

    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))
    await sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!.fn({}, sim.registry.context)

    const schedule = sim.calls.rpc.find((r) => r.name === 'automate.controlPlaneSchedule')!
    const first = (await schedule.fn({}, sim.registry.context)) as { started: number }
    // The ceiling is 5 workers.
    expect(first.started).toBe(5)

    const registry = controlPlaneOf(sim)
    const running = Object.values(registry.items).filter((i) => i.status === 'running')
    expect(running).toHaveLength(5)

    // A second pass finds nothing left to reserve (exclusive reservation).
    const second = (await schedule.fn({}, sim.registry.context)) as { started: number }
    expect(second.started).toBe(0)
  })

  it('persists the registry under a single storage key (atomic round-trip)', async () => {
    const sim = makeSim()
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/issues?')) {
        return new Response(JSON.stringify([issuePayload(1)]), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchStub as unknown as typeof fetch)

    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))
    await sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!.fn({}, sim.registry.context)

    // The registry lives under ONE key, so its read-modify-write never
    // races another key's write.
    const keys = [...sim.backing.keys()]
    expect(keys).toContain(CONTROL_PLANE_STORAGE_KEY)
    expect(typeof sim.backing.get(CONTROL_PLANE_STORAGE_KEY)).toBe('string')
  })

  it('attributes the token usage reported by the host to the running issue', async () => {
    const sim = makeSim()
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/issues?')) {
        return new Response(JSON.stringify([issuePayload(1)]), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchStub as unknown as typeof fetch)

    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))
    await sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!.fn({}, sim.registry.context)
    await sim.calls.rpc.find((r) => r.name === 'automate.controlPlaneSchedule')!.fn({}, sim.registry.context)

    const registry = controlPlaneOf(sim)
    const item = registry.items['acme/widgets#1']
    expect(item?.status).toBe('running')
    const sessionId = item?.sessionId
    expect(sessionId).toBeTruthy()

    await hookOf(
      sim,
      'llm.completed',
    )({
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

    const after = controlPlaneOf(sim)
    expect(after.items['acme/widgets#1']?.tokens.totalTokens).toBe(1200)
    expect(after.items['acme/widgets#1']?.tokens.cachedPromptTokens).toBe(600)
  })

  it('exposes the control-plane metrics through an RPC', async () => {
    const sim = makeSim()
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))

    const status = (await sim.calls.rpc
      .find((r) => r.name === 'automate.controlPlaneStatus')!
      .fn({}, sim.registry.context)) as {
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
    const sim = makeSim()
    ;(sim.registry.context.settings as ReturnType<typeof vi.fn>).mockReturnValue({
      'github.token': 'tok',
      'repos.mapping': 'acme/widgets=proj-1',
      'workflows.chain': CHAIN.join('\n'),
      'scan.startupScan': false,
      'batch.maxConcurrency': 50,
      'batch.maxConcurrencyPerRepo': 50,
      'ordering.dependencyPattern': '',
      dryRun: false,
      'history.retentionCount': 100,
      'pr.monitorEnabled': false,
      'budget.maxTokensPerIssue': 0,
      'control.leaseMinutes': 10,
    })
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))

    const status = (await sim.calls.rpc
      .find((r) => r.name === 'automate.controlPlaneStatus')!
      .fn({}, sim.registry.context)) as { options: { maxWorkers: number; maxWorkersPerRepo: number } }
    expect(status.options.maxWorkers).toBe(5)
    expect(status.options.maxWorkersPerRepo).toBe(5)
  })
})

describe('AC12 — the host mechanisms are reused, not duplicated', () => {
  it('does not introduce a second state machine: the chain engine is untouched', async () => {
    // The plugin still drives ONE workflow per chain step through the host.
    // The control plane only decides what runs; it never advances a chain.
    const sim = makeSim()
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/issues?')) {
        return new Response(JSON.stringify([issuePayload(1)]), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchStub as unknown as typeof fetch)

    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))
    await sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!.fn({}, sim.registry.context)
    await sim.calls.rpc.find((r) => r.name === 'automate.controlPlaneSchedule')!.fn({}, sim.registry.context)

    // The scheduler reserved the issue and started a session, but it did
    // NOT launch a workflow: the chain engine owns that.
    expect(sim.launched).toHaveLength(0)
    expect(controlPlaneOf(sim).items['acme/widgets#1']?.status).toBe('running')
  })

  it('keeps the workflow launch in the chain engine (host event drives the next step)', async () => {
    const sim = makeSim()
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/issues?')) {
        return new Response(JSON.stringify([issuePayload(1)]), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchStub as unknown as typeof fetch)

    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))
    await sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!.fn({}, sim.registry.context)

    // The legacy queue path still launches the chain.
    const queued = JSON.parse(sim.backing.get('queue') as string) as QueueEntry[]
    await sim.calls.rpc
      .find((r) => r.name === 'automate.startIssue')!
      .fn({ queueId: queued[0]!.id }, sim.registry.context)

    expect(sim.launched).toHaveLength(1)
    expect(sim.launched[0]?.workflowId).toBe('plan-issue-v3')
  })
})
