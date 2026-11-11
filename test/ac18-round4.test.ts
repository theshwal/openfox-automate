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
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { _resetLifecycleForTesting, register } from '../src/index.js'
import { monitorPRs } from '../src/pr-monitor.js'
import { ControlPlaneStore, CONTROL_PLANE_STORAGE_KEY } from '../src/control-plane-store.js'
import type { PluginContext, PluginRegistry } from 'openfox/plugin'
import type { QueueEntry } from '../src/types.js'

const CHAIN = ['plan-issue-v3']

interface Hook {
  h: string
  fn: (p: unknown) => Promise<void>
}

function makeSim(
  issues: Array<{ number: number; title: string; body?: string }>,
  options: { prMerged?: boolean } = {},
) {
  const backing = new Map<string, unknown>()
  const calls: {
    hook: Hook[]
    rpc: Array<{ name: string; fn: (p: unknown, c: unknown) => Promise<unknown> }>
  } = { hook: [], rpc: [] }
  const httpCalls: string[] = []
  const moveBodies: unknown[] = []

  const context = {
    id: 'openfox-automate',
    version: '0.1.0',
    runtime: { mode: 'development' as const, configDirectory: '/tmp/openfox-g' },
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
      'pr.monitorEnabled': true,
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

  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    httpCalls.push(`${method} ${url}`)
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
    if (method === 'GET' && url.includes('/pulls/')) {
      return new Response(
        JSON.stringify({
          number: 42,
          state: options.prMerged === false ? 'open' : 'closed',
          merged: options.prMerged !== false,
          mergeable: true,
          html_url: 'https://github.com/acme/widgets/pull/42',
        }),
        { status: 200 },
      )
    }
    if (method !== 'GET' && url.endsWith('/api/sessions')) {
      return new Response(JSON.stringify({ session: { id: 'sess-1' } }), { status: 201 })
    }
    if (method === 'POST' && url.endsWith('/tasks')) {
      return new Response(JSON.stringify({ task: { id: 'task-1' } }), { status: 201 })
    }
    if (method === 'POST' && url.includes('/move')) {
      if (init?.body) moveBodies.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify({ task: { id: 'task-1' } }), { status: 200 })
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchStub as unknown as typeof fetch)

  return { registry, calls, backing, httpCalls, moveBodies, context }
}

function readJson<T>(backing: Map<string, unknown>, key: string): T | undefined {
  const raw = backing.get(key)
  return raw === undefined ? undefined : (JSON.parse(raw as string) as T)
}

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

afterEach(() => {
  _resetLifecycleForTesting()
  vi.unstubAllGlobals()
})

describe('AC18 G1 — the PR monitor never diverges', () => {
  it('does not move the control plane when the legacy transition is refused', async () => {
    const sim = makeSim([{ number: 1, title: 'I1' }])
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))
    await sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!.fn({}, sim.registry.context)
    await sim.calls.rpc.find((r) => r.name === 'automate.controlPlaneSchedule')!.fn({}, sim.registry.context)

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
        store: {
          loadActive: async () => readJson<QueueEntry[]>(sim.backing, 'queue') ?? [],
          transitionTo: async (id: string, next: string, patch: unknown) => {
            const active = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
            const idx = active.findIndex((e) => e.id === id)
            if (idx < 0) throw new Error(`not found: ${id}`)
            if (active[idx]!.status === 'blocked' && next === 'done') {
              throw new Error('Invalid queue transition: blocked → done')
            }
            active[idx] = { ...active[idx]!, status: next as never, ...(patch as object) }
            sim.backing.set('queue', JSON.stringify(active))
            return active[idx]!
          },
        } as never,
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
    const sim = makeSim([{ number: 1, title: 'I1' }])
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))
    await sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!.fn({}, sim.registry.context)
    await sim.calls.rpc.find((r) => r.name === 'automate.controlPlaneSchedule')!.fn({}, sim.registry.context)

    // The move to in_progress carries the session the plugin created.
    expect(sim.moveBodies).toHaveLength(1)
    expect(sim.moveBodies[0]).toMatchObject({ to: 'in_progress', sessionId: 'sess-1' })
  })
})

describe('AC18 G3 — the admission carries the derived dependencies', () => {
  it('blocks an issue whose dependency is missing, in BOTH views', async () => {
    // Issue 2 depends on issue 3, which does not exist.
    const sim = makeSim([{ number: 2, title: 'B', body: 'Depends on #3' }])
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))
    await sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!.fn({}, sim.registry.context)

    const cp = controlPlane(sim.backing)
    const item = cp.items['acme/widgets#2']
    // The control plane knows the dependency…
    expect(item?.dependsOn).toEqual([3])
    // …and the legacy view blocks the entry.
    expect(readJson<QueueEntry[]>(sim.backing, 'queue')?.[0]?.status).toBe('blocked')

    // The scheduler must NOT start it.
    const result = (await sim.calls.rpc
      .find((r) => r.name === 'automate.controlPlaneSchedule')!
      .fn({}, sim.registry.context)) as { started: number }
    expect(result.started).toBe(0)

    // And the two views agree.
    const status = (await sim.calls.rpc
      .find((r) => r.name === 'automate.controlPlaneStatus')!
      .fn({}, sim.registry.context)) as { divergences: string[] }
    expect(status.divergences).toEqual([])
  })
})

describe('AC18 G4 — the budget block and the removal are mirrored', () => {
  it('mirrors the token-budget block to the legacy entry', async () => {
    const sim = makeSim([{ number: 1, title: 'I1' }])
    ;(sim.registry.context.settings as ReturnType<typeof vi.fn>).mockReturnValue({
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
      'budget.maxTokensPerIssue': 1000,
      'control.leaseMinutes': 10,
      'host.baseUrl': 'http://127.0.0.1:10369',
    })
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))
    await sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!.fn({}, sim.registry.context)
    await sim.calls.rpc.find((r) => r.name === 'automate.controlPlaneSchedule')!.fn({}, sim.registry.context)

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

    const status = (await sim.calls.rpc
      .find((r) => r.name === 'automate.controlPlaneStatus')!
      .fn({}, sim.registry.context)) as { divergences: string[] }
    expect(status.divergences).toEqual([])
  })

  it('removes the issue from the control plane too', async () => {
    const sim = makeSim([{ number: 1, title: 'I1' }])
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))
    await sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!.fn({}, sim.registry.context)

    const queue = readJson<QueueEntry[]>(sim.backing, 'queue')!
    await sim.calls.rpc
      .find((r) => r.name === 'automate.removeIssue')!
      .fn({ queueId: queue[0]!.id }, sim.registry.context)

    expect(controlPlane(sim.backing).items['acme/widgets#1']).toBeUndefined()
    expect(readJson<QueueEntry[]>(sim.backing, 'queue')).toHaveLength(0)
  })
})
