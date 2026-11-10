/**
 * AC18 — regression tests for the defects found by the SECOND
 * independent verification round.
 *
 *   E1 — the session creation did NOT use the orchestration port, so the
 *        plugin had no working session path on a real host (which exposes
 *        neither `context.host` nor `context.openFoxInternals`).
 *
 *   E2 — `automate.startIssue` still used the BULK reservation, which
 *        left the other issues 'reserved' with no session.
 *
 *   E3 — a dry-run pass reserved the issues and then discarded them, so
 *        turning the dry run off left the queue blocked by orphans.
 *
 *   E4 — the spawn-failure path wrote only the legacy entry, leaving the
 *        control plane 'reserved' (a drift and an orphan).
 *
 * Everything is offline: a fake GitHub and a fake host HTTP API.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { _resetLifecycleForTesting, register } from '../src/index.js'
import { CONTROL_PLANE_STORAGE_KEY } from '../src/control-plane-store.js'
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
  httpCalls: string[]
  sessionsCreated: string[]
  workflowsLaunched: string[]
}

function makeSim(
  issues: Array<{ number: number; title: string }>,
  options: { hostReachable?: boolean; settings?: Record<string, unknown> } = {},
): Sim {
  const backing = new Map<string, unknown>()
  const calls: {
    hook: Hook[]
    rpc: Array<{ name: string; fn: (p: unknown, c: unknown) => Promise<unknown> }>
  } = { hook: [], rpc: [] }
  const httpCalls: string[] = []
  const sessionsCreated: string[] = []
  const workflowsLaunched: string[] = []

  const context = {
    id: 'openfox-automate',
    version: '0.1.0',
    runtime: { mode: 'development' as const, configDirectory: '/tmp/openfox-e' },
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

  // The fake HOST HTTP API — the real 2.0.161 context has no `host`.
  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    httpCalls.push(`${method} ${url}`)
    if (method !== 'GET' && url.endsWith('/api/sessions')) {
      if (options.hostReachable === false) {
        return new Response('unreachable', { status: 500 })
      }
      sessionsCreated.push('c')
      return new Response(
        JSON.stringify({ session: { id: `sess-${sessionsCreated.length}`, workdir: '/tmp/x' } }),
        { status: 201 },
      )
    }
    if (method === 'POST' && url.includes('/message')) {
      if (init?.body) {
        const body = JSON.parse(String(init.body)) as { content?: string }
        workflowsLaunched.push(body.content ?? '')
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }
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
    if (options.hostReachable === false) {
      return new Response('unreachable', { status: 500 })
    }
    return new Response('{}', { status: 200 })
  })
  vi.stubGlobal('fetch', fetchStub as unknown as typeof fetch)

  return { registry, calls, backing, httpCalls, sessionsCreated, workflowsLaunched }
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

describe('AC18 E1 — the session is created through the supported HTTP API', () => {
  it('creates the session on the real host (no context.host) and launches the workflow', async () => {
    const sim = makeSim([{ number: 1, title: 'I1' }])
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))
    await sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!.fn({}, sim.registry.context)

    const result = (await sim.calls.rpc
      .find((r) => r.name === 'automate.controlPlaneSchedule')!
      .fn({}, sim.registry.context)) as { started: number }

    // The session went through the host's HTTP API.
    expect(result.started).toBe(1)
    expect(sim.sessionsCreated).toHaveLength(1)
    expect(sim.httpCalls.some((c) => c.startsWith('POST') && c.endsWith('/api/sessions'))).toBe(true)
    // And the workflow was launched through the host's slash syntax.
    expect(sim.workflowsLaunched[0]).toContain('/plan-issue-v3')
    expect(controlPlane(sim.backing).items['acme/widgets#1']?.status).toBe('running')
  })
})

describe('AC18 E2 — startIssue reserves only its own issue', () => {
  it('leaves no orphan reservation behind', async () => {
    const sim = makeSim(Array.from({ length: 10 }, (_, i) => ({ number: i + 1, title: `I${i + 1}` })))
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))
    await sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!.fn({}, sim.registry.context)

    const queue = readJson<QueueEntry[]>(sim.backing, 'queue')!
    await sim.calls.rpc
      .find((r) => r.name === 'automate.startIssue')!
      .fn({ queueId: queue[0]!.id }, sim.registry.context)

    const cp = controlPlane(sim.backing)
    // Exactly ONE issue is taken (the one being started) and it has a
    // session; the other nine stay 'queued'. The decisive property is
    // that NO item is left 'reserved' without a session.
    expect(Object.values(cp.items).filter((i) => i.status === 'reserved')).toHaveLength(0)
    expect(Object.values(cp.items).filter((i) => i.status === 'running')).toHaveLength(1)
    expect(Object.values(cp.items).filter((i) => i.status === 'queued')).toHaveLength(9)
    expect(Object.values(cp.items).find((i) => i.status === 'running')?.sessionId).toBeTruthy()

    // And the queue still drains: the schedule pass can pick the others up.
    await sim.calls.rpc.find((r) => r.name === 'automate.controlPlaneSchedule')!.fn({}, sim.registry.context)
    expect(sim.sessionsCreated.length).toBeGreaterThan(1)
  })
})

describe('AC18 E3 — a dry run reserves nothing', () => {
  it('leaves no orphan reservation that would block the queue afterwards', async () => {
    const sim = makeSim([{ number: 1, title: 'I1' }], { settings: { dryRun: true } })
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))
    await sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!.fn({}, sim.registry.context)

    const result = (await sim.calls.rpc
      .find((r) => r.name === 'automate.controlPlaneSchedule')!
      .fn({}, sim.registry.context)) as { started: number }
    expect(result.started).toBe(0)
    expect(sim.sessionsCreated).toHaveLength(0)

    // No reservation was left behind.
    const cp = controlPlane(sim.backing)
    expect(Object.values(cp.items).filter((i) => i.status === 'reserved')).toHaveLength(0)
  })
})

describe('AC18 E4 — the spawn failure updates the control plane', () => {
  it('keeps the two views in agreement when the host refuses the session', async () => {
    const sim = makeSim([{ number: 1, title: 'I1' }], { hostReachable: false })
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))
    await sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!.fn({}, sim.registry.context)

    await sim.calls.rpc.find((r) => r.name === 'automate.controlPlaneSchedule')!.fn({}, sim.registry.context)

    const cp = controlPlane(sim.backing)
    expect(cp.items['acme/widgets#1']?.status).toBe('failed')
    // No orphan reservation is left, and the legacy entry agrees.
    expect(Object.values(cp.items).filter((i) => i.status === 'reserved')).toHaveLength(0)

    const status = (await sim.calls.rpc
      .find((r) => r.name === 'automate.controlPlaneStatus')!
      .fn({}, sim.registry.context)) as { divergences: string[] }
    expect(status.divergences).toEqual([])
  })
})
