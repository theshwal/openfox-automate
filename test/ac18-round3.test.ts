/**
 * AC18 — regression tests for the defects found by the THIRD independent
 * verification round.
 *
 *   F1 — the host does NOT resolve a `/<workflow-id>` prompt sent to
 *        `POST /api/sessions/:id/message` into a workflow launch. The
 *        resolver (`resolveSlashLaunch`) has exactly ONE call site in the
 *        host: the TASK path (`seedSession`). The launch must therefore
 *        go through the task board.
 *
 *   F2 — the PR monitor mutated the control plane BEFORE the legacy
 *        transition; when the store refused the transition (blocked →
 *        done), the two views diverged and the error escaped as an
 *        unhandled rejection.
 *
 *   F3 — an expired lease was reclaimed in the control plane only; the
 *        legacy entry stayed 'running' forever.
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

function makeSim(issues: Array<{ number: number; title: string }>) {
  const backing = new Map<string, unknown>()
  const calls: {
    hook: Hook[]
    rpc: Array<{ name: string; fn: (p: unknown, c: unknown) => Promise<unknown> }>
  } = { hook: [], rpc: [] }
  const httpCalls: string[] = []
  const workflowsLaunched: string[] = []

  const context = {
    id: 'openfox-automate',
    version: '0.1.0',
    runtime: { mode: 'development' as const, configDirectory: '/tmp/openfox-f' },
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
      'ordering.dependencyPattern': '',
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
            body: '',
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
      return new Response(JSON.stringify({ session: { id: 'sess-1' } }), { status: 201 })
    }
    if (method === 'POST' && url.endsWith('/tasks')) {
      if (init?.body) {
        const body = JSON.parse(String(init.body)) as { prompt?: string }
        workflowsLaunched.push(body.prompt ?? '')
      }
      return new Response(JSON.stringify({ task: { id: 'task-1' } }), { status: 201 })
    }
    return new Response(JSON.stringify({ task: { id: 'task-1' } }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchStub as unknown as typeof fetch)

  return { registry, calls, backing, httpCalls, workflowsLaunched, context }
}

function readJson<T>(backing: Map<string, unknown>, key: string): T | undefined {
  const raw = backing.get(key)
  return raw === undefined ? undefined : (JSON.parse(raw as string) as T)
}

function controlPlane(backing: Map<string, unknown>): {
  items: Record<string, { key: string; status: string; sessionId?: string; error?: string }>
} {
  return (
    readJson<{
      items: Record<string, { key: string; status: string; sessionId?: string; error?: string }>
    }>(backing, CONTROL_PLANE_STORAGE_KEY) ?? { items: {} }
  )
}

afterEach(() => {
  _resetLifecycleForTesting()
  vi.unstubAllGlobals()
})

describe('AC18 F1 — the workflow launch goes through the task board', () => {
  it('never sends the launch prompt to the session-message route', async () => {
    const sim = makeSim([{ number: 1, title: 'I1' }])
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))
    await sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!.fn({}, sim.registry.context)
    await sim.calls.rpc.find((r) => r.name === 'automate.controlPlaneSchedule')!.fn({}, sim.registry.context)

    // The prompt went to the task board…
    expect(sim.workflowsLaunched[0]).toContain('/plan-issue-v3')
    expect(sim.httpCalls.some((c) => c.includes('/api/projects/proj-1/tasks'))).toBe(true)
    // …and NEVER to the session-message route, which would deliver the
    // prompt literally and never start a workflow.
    expect(sim.httpCalls.some((c) => c.includes('/api/sessions/sess-1/message'))).toBe(false)
  })
})

describe('AC18 F2 — the PR monitor keeps the two views in agreement', () => {
  it('does not diverge when the legacy transition is refused', async () => {
    const sim = makeSim([{ number: 1, title: 'I1' }])
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))
    await sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!.fn({}, sim.registry.context)
    await sim.calls.rpc.find((r) => r.name === 'automate.controlPlaneSchedule')!.fn({}, sim.registry.context)

    // The issue is blocked (the store refuses blocked → done).
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

    const queue = readJson<QueueEntry[]>(sim.backing, 'queue')!
    const entry = queue[0]!
    const store = new ControlPlaneStore({
      get: async (k: string) => {
        const raw = sim.backing.get(k)
        return raw === undefined ? undefined : (JSON.parse(raw as string) as unknown)
      },
      set: async (k: string, v: unknown) => {
        sim.backing.set(k, JSON.stringify(v))
      },
    })

    // The PR is merged, but the entry is 'blocked': the store refuses
    // blocked → done. The monitor must not leave a divergence behind, and
    // must not throw.
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/pulls/')) {
        return new Response(
          JSON.stringify({
            number: 42,
            state: 'closed',
            merged: true,
            mergeable: null,
            html_url: 'https://github.com/acme/widgets/pull/42',
          }),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchStub as unknown as typeof fetch)

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

    // The control plane was NOT moved to 'done': the legacy transition
    // refused it, so the authority must not claim it happened.
    expect(controlPlane(sim.backing).items['acme/widgets#1']?.status).not.toBe('done')
    void entry
  })
})

describe('AC18 F3 — a reclaimed lease is mirrored to the legacy queue', () => {
  it('blocks the legacy entry too, so the two views agree', async () => {
    const sim = makeSim([{ number: 1, title: 'I1' }])
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))
    await sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!.fn({}, sim.registry.context)
    await sim.calls.rpc.find((r) => r.name === 'automate.controlPlaneSchedule')!.fn({}, sim.registry.context)

    // The lease expires: the control plane reclaims the item.
    const cp = controlPlane(sim.backing)
    const item = cp.items['acme/widgets#1']
    expect(item?.status).toBe('running')
    if (!item) throw new Error('the item must exist')
    item.leaseExpiresAt = Date.now() - 1000
    sim.backing.set(CONTROL_PLANE_STORAGE_KEY, JSON.stringify(cp))

    // The next scheduling pass reclaims it and must mirror the block.
    await sim.calls.rpc.find((r) => r.name === 'automate.controlPlaneSchedule')!.fn({}, sim.registry.context)

    const after = controlPlane(sim.backing)
    expect(after.items['acme/widgets#1']?.status).toBe('blocked')

    const queue = readJson<QueueEntry[]>(sim.backing, 'queue')!
    expect(queue[0]?.status).toBe('blocked')

    const status = (await sim.calls.rpc
      .find((r) => r.name === 'automate.controlPlaneStatus')!
      .fn({}, sim.registry.context)) as { divergences: string[] }
    expect(status.divergences).toEqual([])
  })
})
