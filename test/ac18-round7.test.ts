/**
 * AC18 — regression tests for the last two blocking defects.
 *
 *   J1 — the dedup against the history was defeated by the history PRUNING:
 *        `orderAndStore` prunes the oldest history entries on every scan, so
 *        a completed issue left the dedup set and the next scan re-added
 *        it — the legacy path then created a SECOND session for an issue
 *        that was already done.
 *
 *   J2 — the single-issue scheduling path (the legacy path and
 *        `automate.startIssue`) did not mirror a block raised by the
 *        dependency gate: the control plane said 'blocked' while the legacy
 *        entry stayed 'queued'.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { _resetLifecycleForTesting, register } from '../src/index.js'
import { CONTROL_PLANE_STORAGE_KEY } from '../src/control-plane-store.js'
import type { PluginContext, PluginRegistry } from 'openfox/plugin'
import type { QueueEntry } from '../src/types.js'

const CHAIN = ['plan-issue-v3']

interface Hook {
  h: string
  fn: (p: unknown) => Promise<void>
}

function makeSim(
  issues: Array<{ number: number; title: string; body?: string }>,
  options: { settings?: Record<string, unknown> } = {},
) {
  const backing = new Map<string, unknown>()
  const calls: {
    hook: Hook[]
    rpc: Array<{ name: string; fn: (p: unknown, c: unknown) => Promise<unknown> }>
  } = { hook: [], rpc: [] }
  const sessionsCreated: string[] = []

  const context = {
    id: 'openfox-automate',
    version: '0.1.0',
    runtime: { mode: 'development' as const, configDirectory: '/tmp/openfox-j' },
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
      ...(options.settings ?? {}),
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

  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (method === 'GET' && url.includes('/issues?')) {
      return new Response(
        JSON.stringify(
          issues.map((i) => ({
            number: i.number,
            title: i.title,
            body: i.body ?? '',
            html_url: `https://github.com/acme/widgets/issues/${i.number}`,
            state: 'open',
            labels: [],
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            user: { login: 'r' },
          })),
        ),
        { status: 200 },
      )
    }
    if (method !== 'GET' && url.endsWith('/api/sessions')) {
      sessionsCreated.push('c')
      return new Response(JSON.stringify({ session: { id: `sess-${sessionsCreated.length}` } }), {
        status: 201,
      })
    }
    if (method === 'POST' && url.endsWith('/tasks')) {
      return new Response(JSON.stringify({ task: { id: 'task-1' } }), { status: 201 })
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchStub as unknown as typeof fetch)

  return { registry, calls, backing, sessionsCreated, context }
}

function readJson<T>(backing: Map<string, unknown>, key: string): T | undefined {
  const raw = backing.get(key)
  return raw === undefined ? undefined : (JSON.parse(raw as string) as T)
}

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

describe('AC18 J1 — the history pruning cannot resurrect a completed issue', () => {
  it('does not re-add it, and creates no second session', async () => {
    // 11 issues, a history that keeps only 10: the oldest completed issue
    // is pruned, so a dedup based on the history would forget it.
    const issues = Array.from({ length: 11 }, (_, i) => ({
      number: i + 1,
      title: `I${i + 1}`,
    }))
    const sim = makeSim(issues, { settings: { 'history.retentionCount': 10 } })
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))
    const scan = sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!
    const wfHook = sim.calls.hook.find((h) => h.h === 'workflow.execution.changed')!.fn

    await scan.fn({}, sim.registry.context)
    await sim.calls.rpc.find((r) => r.name === 'automate.controlPlaneSchedule')!.fn({}, sim.registry.context)

    // All the running issues complete.
    const cp = controlPlane(sim.backing)
    for (const item of Object.values(cp.items)) {
      if (item.status !== 'running') continue
      await wfHook({
        event: 'workflow.execution.changed',
        timestamp: new Date().toISOString(),
        sessionId: `sess-${Object.values(cp.items).indexOf(item) + 1}`,
        data: {
          executionId: `exec-${item.key}`,
          workflowId: 'plan-issue-v3',
          workflowName: 'plan-issue-v3',
          status: 'completed',
        },
      })
    }
    const sessionsAfterFirst = sim.sessionsCreated.length
    expect(sessionsAfterFirst).toBeGreaterThan(0)

    // The next scan prunes the history, but must NOT re-add the finished
    // issues: the control plane is the durable authority.
    await scan.fn({}, sim.registry.context)

    // Only the issues that are STILL running (or queued) are in the queue:
    // the completed ones were not re-added, even though the history was
    // pruned.
    const queued = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
    const cp2 = controlPlane(sim.backing)
    const completed = Object.values(cp2.items).filter((i) => i.status === 'done')
    expect(completed.length).toBeGreaterThan(0)
    for (const done of completed) {
      const number = Number(done.key.split('#')[1])
      expect(queued.find((e) => e.issueNumber === number)).toBeUndefined()
    }

    // And the legacy path must not start them again.
    await sim.calls.hook.find((h) => h.h === 'task.completed')!.fn({})
    expect(sim.sessionsCreated).toHaveLength(sessionsAfterFirst)

    const status = (await sim.calls.rpc
      .find((r) => r.name === 'automate.controlPlaneStatus')!
      .fn({}, sim.registry.context)) as { divergences: string[] }
    expect(status.divergences).toEqual([])
  })
})

describe('AC18 J2 — the single-issue path mirrors the dependency block', () => {
  it('leaves the entry blocked in both views', async () => {
    // #2 depends on #3, which is removed — so the dependency is missing.
    const sim = makeSim([
      { number: 2, title: 'B', body: 'Depends on #3' },
      { number: 3, title: 'C' },
    ])
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))
    await sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!.fn({}, sim.registry.context)

    // Remove the dependency from BOTH views.
    const queue = readJson<QueueEntry[]>(sim.backing, 'queue')!
    const dep = queue.find((e) => e.issueNumber === 3)!
    await sim.calls.rpc
      .find((r) => r.name === 'automate.removeIssue')!
      .fn({ queueId: dep.id }, sim.registry.context)

    // The dependent issue can no longer run.
    const dependent = queue.find((e) => e.issueNumber === 2)!
    await expect(
      sim.calls.rpc
        .find((r) => r.name === 'automate.startIssue')!
        .fn({ queueId: dependent.id }, sim.registry.context),
    ).rejects.toThrow(/blocked/)

    // Both views agree.
    expect(controlPlane(sim.backing).items['acme/widgets#2']?.status).toBe('blocked')
    const after = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
    expect(after.find((e) => e.issueNumber === 2)?.status).toBe('blocked')

    const status = (await sim.calls.rpc
      .find((r) => r.name === 'automate.controlPlaneStatus')!
      .fn({}, sim.registry.context)) as { divergences: string[] }
    expect(status.divergences).toEqual([])
  })
})
