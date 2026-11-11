/**
 * AC18 — regression tests for the defects found by the final verification
 * round.
 *
 *   H1 — after a scan, the control plane admitted the entries as 'queued'
 *        while the legacy view had blocked them (missing dependency): the
 *        two views diverged.
 *
 *   H2 — the legacy scheduler path did not apply the dependency gate, so it
 *        started an issue whose prerequisite was missing.
 *
 *   H3 — a reclaimed (expired) lease was mirrored with a transition the
 *        store REFUSED ('queued' → 'blocked'), so the mirror was silently
 *        dropped and the legacy entry stayed 'queued' — and the legacy path
 *        then started a SECOND session while the first was still alive.
 *
 *   H4 — `automate.reprocess` did not stop the previous session, so it
 *        created a second session for the same issue.
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

function makeSim(issues: Array<{ number: number; title: string; body?: string }>) {
  const backing = new Map<string, unknown>()
  const calls: {
    hook: Hook[]
    rpc: Array<{ name: string; fn: (p: unknown, c: unknown) => Promise<unknown> }>
  } = { hook: [], rpc: [] }
  const httpCalls: string[] = []
  const sessionsCreated: string[] = []

  const context = {
    id: 'openfox-automate',
    version: '0.1.0',
    runtime: { mode: 'development' as const, configDirectory: '/tmp/openfox-h' },
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

  return { registry, calls, backing, httpCalls, sessionsCreated, context }
}

function readJson<T>(backing: Map<string, unknown>, key: string): T | undefined {
  const raw = backing.get(key)
  return raw === undefined ? undefined : (JSON.parse(raw as string) as T)
}

function controlPlane(backing: Map<string, unknown>): {
  items: Record<
    string,
    {
      key: string
      status: string
      sessionId?: string
      error?: string
      dependsOn?: number[]
      leaseExpiresAt?: number
    }
  >
} {
  return (
    readJson<{
      items: Record<
        string,
        {
          key: string
          status: string
          sessionId?: string
          error?: string
          dependsOn?: number[]
          leaseExpiresAt?: number
        }
      >
    }>(backing, CONTROL_PLANE_STORAGE_KEY) ?? { items: {} }
  )
}

afterEach(() => {
  _resetLifecycleForTesting()
  vi.unstubAllGlobals()
})

describe('AC18 H1 — a scan leaves the two views in agreement', () => {
  it('blocks the entry whose dependency is missing in BOTH views', async () => {
    const sim = makeSim([{ number: 2, title: 'B', body: 'Depends on #3' }])
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))
    await sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!.fn({}, sim.registry.context)

    const cp = controlPlane(sim.backing)
    expect(cp.items['acme/widgets#2']?.status).toBe('blocked')
    expect(readJson<QueueEntry[]>(sim.backing, 'queue')?.[0]?.status).toBe('blocked')

    const status = (await sim.calls.rpc
      .find((r) => r.name === 'automate.controlPlaneStatus')!
      .fn({}, sim.registry.context)) as { divergences: string[] }
    expect(status.divergences).toEqual([])
  })
})

describe('AC18 H2 — the dependency gate guards the legacy path too', () => {
  it('does not start an issue whose dependency is missing', async () => {
    // #1 depends on the missing #9; #2 depends on #1.
    const sim = makeSim([
      { number: 1, title: 'A', body: 'Depends on #9' },
      { number: 2, title: 'B', body: 'Depends on #1' },
    ])
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))
    await sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!.fn({}, sim.registry.context)

    // The legacy path runs (as it does on a workflow completion).
    await sim.calls.hook.find((h) => h.h === 'task.completed')!.fn({})

    // Neither issue may run: #1's dependency is missing, #2's is not done.
    expect(sim.sessionsCreated).toHaveLength(0)
    const cp = controlPlane(sim.backing)
    expect(cp.items['acme/widgets#1']?.status).toBe('blocked')
    expect(cp.items['acme/widgets#2']?.status).not.toBe('running')
  })
})

describe('AC18 H3 — a reclaimed lease is mirrored', () => {
  it('blocks the legacy entry too, and no second session is created', async () => {
    const sim = makeSim([{ number: 1, title: 'I1' }])
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))
    await sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!.fn({}, sim.registry.context)
    await sim.calls.rpc.find((r) => r.name === 'automate.controlPlaneSchedule')!.fn({}, sim.registry.context)
    expect(sim.sessionsCreated).toHaveLength(1)

    // The lease expires while the first session may still be alive.
    const cp = controlPlane(sim.backing)
    const item = cp.items['acme/widgets#1']
    if (!item) throw new Error('the item must exist')
    item.leaseExpiresAt = Date.now() - 1000
    sim.backing.set(CONTROL_PLANE_STORAGE_KEY, JSON.stringify(cp))

    // The next pass reclaims it.
    await sim.calls.rpc.find((r) => r.name === 'automate.controlPlaneSchedule')!.fn({}, sim.registry.context)

    expect(controlPlane(sim.backing).items['acme/widgets#1']?.status).toBe('blocked')
    expect(readJson<QueueEntry[]>(sim.backing, 'queue')?.[0]?.status).toBe('blocked')

    // And the legacy path does not start a SECOND session for it.
    await sim.calls.hook.find((h) => h.h === 'task.completed')!.fn({})
    expect(sim.sessionsCreated).toHaveLength(1)

    const status = (await sim.calls.rpc
      .find((r) => r.name === 'automate.controlPlaneStatus')!
      .fn({}, sim.registry.context)) as { divergences: string[] }
    expect(status.divergences).toEqual([])
  })
})

describe('AC18 H4 — reprocess stops the previous session', () => {
  it('does not leave two sessions for the same issue', async () => {
    const sim = makeSim([{ number: 1, title: 'I1' }])
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))
    await sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!.fn({}, sim.registry.context)
    await sim.calls.rpc.find((r) => r.name === 'automate.controlPlaneSchedule')!.fn({}, sim.registry.context)
    expect(sim.sessionsCreated).toHaveLength(1)

    const queue = readJson<QueueEntry[]>(sim.backing, 'queue')!
    const id = queue[0]!.id

    // The workflow is cancelled -> the entry is blocked and reprocessable.
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

    await sim.calls.rpc
      .find((r) => r.name === 'automate.reprocess')!
      .fn({ queueId: id }, sim.registry.context)

    // The previous session was stopped, and the re-run either reuses it or
    // creates exactly one more — never two live at once.
    const stopCalls = sim.httpCalls.filter((c) => c.includes('/stop'))
    expect(stopCalls.length).toBeGreaterThanOrEqual(1)
  })
})
