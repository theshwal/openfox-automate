/**
 * AC18-13 — A dependency removed from the queue must not diverge the views,
 * and must never clobber a RUNNING issue.
 *
 * The defect: `automate.removeIssue` deletes the item from the durable
 * registry, but the DEPENDENT keeps `dependsOn=[3]`. The scan-time
 * dependency decision then blocked the dependent in the LEGACY view only
 * ('missing or circular dependency'), while the control plane kept it
 * 'queued' — the two views disagreed permanently, and a dependent that
 * was already RUNNING got clobbered mid-run.
 *
 * The fix: the scan-time dependency decision belongs to the control
 * plane. It is recorded THERE first, and the legacy entry is written from
 * it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { _resetLifecycleForTesting, register } from '../src/index.js'
import type { PluginContext, PluginRegistry } from 'openfox/plugin'
import type { QueueEntry } from '../src/types.js'

const CHAIN = ['plan-issue-v3', 'build-verify-v3', 'publish-pr-v1']

interface Hook {
  h: string
  fn: (p: unknown) => Promise<void>
}

interface Sim {
  registry: PluginRegistry
  calls: { hook: Hook[]; rpc: Array<{ name: string; fn: (p: unknown, c: unknown) => Promise<unknown> }> }
  backing: Map<string, unknown>
  sessions: string[]
  /** Issue numbers the fake GitHub no longer returns (closed). */
  closed: number[]
}

function makeSim(): Sim {
  const backing = new Map<string, unknown>()
  const calls: {
    hook: Hook[]
    rpc: Array<{ name: string; fn: (p: unknown, c: unknown) => Promise<unknown> }>
  } = { hook: [], rpc: [] }
  const sessions: string[] = []
  const closed: number[] = []

  const context = {
    id: 'openfox-automate',
    version: '0.1.0',
    runtime: { mode: 'development' as const, configDirectory: '/tmp/openfox-m1' },
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
      return new Response(JSON.stringify(issues.filter((i) => !closed.includes(i.number))), { status: 200 })
    }
    if (method !== 'GET' && url.endsWith('/api/sessions')) {
      sessions.push(`sess-${sessions.length + 1}`)
      return new Response(JSON.stringify({ session: { id: `sess-${sessions.length}` } }), {
        status: 201,
      })
    }
    if (method === 'POST' && url.endsWith('/tasks')) {
      return new Response(JSON.stringify({ task: { id: 'task-1' } }), { status: 201 })
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchStub as unknown as typeof fetch)

  return { registry, calls, backing, sessions, closed }
}

function readJson<T>(backing: Map<string, unknown>, key: string): T | undefined {
  const raw = backing.get(key)
  return raw === undefined ? undefined : (JSON.parse(raw as string) as T)
}

function controlPlane(backing: Map<string, unknown>): {
  items: Record<string, { key: string; status: string; error?: string; sessionId?: string }>
} {
  return (
    readJson<{
      items: Record<string, { key: string; status: string; error?: string; sessionId?: string }>
    }>(backing, 'control_plane') ?? { items: {} }
  )
}

afterEach(() => {
  _resetLifecycleForTesting()
  vi.unstubAllGlobals()
})

describe('AC18-13 — a removed dependency never diverges the views', () => {
  it('blocks the dependent in BOTH views after removeIssue + scan', async () => {
    const sim = makeSim()
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))
    const scan = sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!
    await scan.fn({}, sim.registry.context)

    // #3 is closed on GitHub but still lingers in the queue.
    const queue = readJson<QueueEntry[]>(sim.backing, 'queue')!
    const dependency = queue.find((e) => e.issueNumber === 3)!
    sim.closed.push(3)
    await sim.calls.rpc
      .find((r) => r.name === 'automate.removeIssue')!
      .fn({ queueId: dependency.id }, sim.registry.context)

    await scan.fn({}, sim.registry.context)

    // The two views agree.
    const cp = controlPlane(sim.backing)
    const legacy = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
    const dependentLegacy = legacy.find((e) => e.issueNumber === 2)
    const dependentCp = cp.items['acme/widgets#2']
    expect(dependentCp?.status).toBe(dependentLegacy?.status)
    expect(dependentLegacy?.status).toBe('blocked')

    const status = (await sim.calls.rpc
      .find((r) => r.name === 'automate.controlPlaneStatus')!
      .fn({}, sim.registry.context)) as { divergences: string[] }
    expect(status.divergences).toEqual([])
  })

  it('NEVER clobbers a RUNNING dependent', async () => {
    const sim = makeSim()
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))
    const scan = sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!
    await scan.fn({}, sim.registry.context)
    await sim.calls.rpc.find((r) => r.name === 'automate.controlPlaneSchedule')!.fn({}, sim.registry.context)

    // #3 (the dependency) runs first. It completes, so #2 becomes
    // schedulable and runs too.
    const wfHook = sim.calls.hook.find((h) => h.h === 'workflow.execution.changed')!.fn
    for (const step of CHAIN) {
      await wfHook({
        event: 'workflow.execution.changed',
        timestamp: new Date().toISOString(),
        sessionId: 'sess-1',
        data: {
          executionId: `exec-${step}`,
          workflowId: step,
          workflowName: step,
          status: 'completed',
        },
      })
    }
    await sim.calls.rpc.find((r) => r.name === 'automate.controlPlaneSchedule')!.fn({}, sim.registry.context)

    // Now the DEPENDENT (#2) is the running one.
    const cp = controlPlane(sim.backing)
    const running = Object.values(cp.items).find((i) => i.status === 'running')
    expect(running?.key).toBe('acme/widgets#2')

    // Its dependency (#3) is removed while #2 runs.
    const queue = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
    const dependency = queue.find((e) => e.issueNumber === 3)
    if (dependency) {
      sim.closed.push(3)
      await sim.calls.rpc
        .find((r) => r.name === 'automate.removeIssue')!
        .fn({ queueId: dependency.id }, sim.registry.context)
    }

    await scan.fn({}, sim.registry.context)

    // The RUNNING dependent was NOT clobbered: it keeps running, and the
    // two views still agree.
    const after = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
    const dependent = after.find((e) => e.issueNumber === 2)
    expect(dependent?.status).toBe('running')

    const status = (await sim.calls.rpc
      .find((r) => r.name === 'automate.controlPlaneStatus')!
      .fn({}, sim.registry.context)) as { divergences: string[] }
    expect(status.divergences).toEqual([])
  })

  it('the fix is idempotent: repeated scans do not drift', async () => {
    const sim = makeSim()
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))
    const scan = sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!
    await scan.fn({}, sim.registry.context)

    const queue = readJson<QueueEntry[]>(sim.backing, 'queue')!
    const dependency = queue.find((e) => e.issueNumber === 3)!
    sim.closed.push(3)
    await sim.calls.rpc
      .find((r) => r.name === 'automate.removeIssue')!
      .fn({ queueId: dependency.id }, sim.registry.context)

    for (let i = 0; i < 5; i += 1) {
      await scan.fn({}, sim.registry.context)
      const status = (await sim.calls.rpc
        .find((r) => r.name === 'automate.controlPlaneStatus')!
        .fn({}, sim.registry.context)) as { divergences: string[] }
      expect(status.divergences).toEqual([])
    }
  })
})
