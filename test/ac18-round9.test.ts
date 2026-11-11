/**
 * AC18 — regression test for the last reported defect.
 *
 * L1 — a dependency that ended 'failed' or 'cancelled' left its dependent
 *      BLOCKED in the legacy queue ONLY, while the control plane said
 *      'queued'.
 *
 * The legacy view used to decide the dependencies on its own, from the
 * ACTIVE queue only. A dependency that had left the active queue
 * (completed, failed or cancelled — it now lives in the history) looked
 * missing, so its dependent was blocked in the legacy queue while the
 * control plane kept it 'queued'. The divergence never healed.
 *
 * The dependency decision now belongs to the control plane, and the
 * legacy view mirrors it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { _resetLifecycleForTesting, register } from '../src/index.js'
import type { PluginContext, PluginRegistry } from 'openfox/plugin'
import type { QueueEntry } from '../src/types.js'

const CHAIN = ['plan-issue-v3']

interface Hook {
  h: string
  fn: (p: unknown) => Promise<void>
}

function makeSim() {
  const closedIssues: number[] = []
  const backing = new Map<string, unknown>()
  const calls: {
    hook: Hook[]
    rpc: Array<{ name: string; fn: (p: unknown, c: unknown) => Promise<unknown> }>
  } = { hook: [], rpc: [] }

  const context = {
    id: 'openfox-automate',
    version: '0.1.0',
    runtime: { mode: 'development' as const, configDirectory: '/tmp/openfox-l' },
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
      'ordering.dependencyPattern': '(#(\\d+))',
      dryRun: false,
      'history.retentionCount': 100,
      'pr.monitorEnabled': false,
      'budget.maxTokensPerIssue': 0,
      'control.leaseMinutes': 10,
      'host.baseUrl': 'http://127.0.0.1:10369',
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

  const issues = [
    {
      number: 2,
      title: 'B',
      body: 'Depends on #3',
      html_url: 'https://github.com/acme/widgets/issues/2',
      state: 'open',
      labels: [],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      user: { login: 'r' },
    },
    {
      number: 3,
      title: 'C',
      body: '',
      html_url: 'https://github.com/acme/widgets/issues/3',
      state: 'open',
      labels: [],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      user: { login: 'r' },
    },
  ]

  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (method === 'GET' && url.includes('/issues?')) {
      return new Response(JSON.stringify(issues.filter((i) => !closedIssues.includes(i.number))), {
        status: 200,
      })
    }
    if (method !== 'GET' && url.endsWith('/api/sessions')) {
      return new Response(JSON.stringify({ session: { id: 'sess-1' } }), { status: 201 })
    }
    if (method === 'POST' && url.endsWith('/tasks')) {
      return new Response(JSON.stringify({ task: { id: 'task-1' } }), { status: 201 })
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchStub as unknown as typeof fetch)

  return { registry, calls, backing, context, closedIssues }
}

function readJson<T>(backing: Map<string, unknown>, key: string): T | undefined {
  const raw = backing.get(key)
  return raw === undefined ? undefined : (JSON.parse(raw as string) as T)
}

afterEach(() => {
  _resetLifecycleForTesting()
  vi.unstubAllGlobals()
})

describe('AC18 L1 — the dependency decision belongs to the control plane', () => {
  it('does not block the dependent in the legacy view when its dependency was cancelled', async () => {
    const sim = makeSim()
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))
    const scan = sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!
    await scan.fn({}, sim.registry.context)
    await sim.calls.rpc.find((r) => r.name === 'automate.controlPlaneSchedule')!.fn({}, sim.registry.context)

    // The dependency (#3) is cancelled and leaves the active queue.
    const queue = readJson<QueueEntry[]>(sim.backing, 'queue')!
    const dependency = queue.find((e) => e.issueNumber === 3)!
    await sim.calls.rpc
      .find((r) => r.name === 'automate.cancelIssue')!
      .fn({ queueId: dependency.id }, sim.registry.context)

    // The next scan must not block the dependent in the legacy view only.
    await scan.fn({}, sim.registry.context)

    const after = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
    const dependent = after.find((e) => e.issueNumber === 2)
    expect(dependent?.status).not.toBe('blocked')

    const status = (await sim.calls.rpc
      .find((r) => r.name === 'automate.controlPlaneStatus')!
      .fn({}, sim.registry.context)) as { divergences: string[] }
    expect(status.divergences).toEqual([])
  })

  it('does not block the dependent when its dependency failed', async () => {
    const sim = makeSim()
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))
    const scan = sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!
    await scan.fn({}, sim.registry.context)

    // The dependency ends 'failed' (as the PR monitor would leave it) and
    // leaves the active queue.
    const queue = readJson<QueueEntry[]>(sim.backing, 'queue')!
    const dependency = queue.find((e) => e.issueNumber === 3)!
    sim.backing.set('history', JSON.stringify([{ ...dependency, status: 'failed', error: 'pr_conflicts' }]))
    sim.backing.set('queue', JSON.stringify(queue.filter((e) => e.issueNumber !== 3)))

    await scan.fn({}, sim.registry.context)

    const after = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
    const dependent = after.find((e) => e.issueNumber === 2)
    expect(dependent?.status).not.toBe('blocked')
  })
})

describe('AC18 L2 — a dependency removed from the queue blocks the dependent in BOTH views', () => {
  it('records the scan-time block in the control plane and mirrors it', async () => {
    const sim = makeSim()
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))
    const scan = sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!
    await scan.fn({}, sim.registry.context)

    // The dependency is removed from the queue AND from the registry.
    const queue = readJson<QueueEntry[]>(sim.backing, 'queue')!
    const dependency = queue.find((e) => e.issueNumber === 3)!
    await sim.calls.rpc
      .find((r) => r.name === 'automate.removeIssue')!
      .fn({ queueId: dependency.id }, sim.registry.context)

    // The dependency is gone from GitHub too, so the next scan does not
    // bring it back — it is genuinely missing.
    sim.closedIssues.push(3)

    // The next scan must block the dependent in BOTH views.
    await scan.fn({}, sim.registry.context)

    const after = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
    const dependent = after.find((e) => e.issueNumber === 2)
    expect(dependent?.status).toBe('blocked')

    const status = (await sim.calls.rpc
      .find((r) => r.name === 'automate.controlPlaneStatus')!
      .fn({}, sim.registry.context)) as { divergences: string[] }
    expect(status.divergences).toEqual([])
  })
})
