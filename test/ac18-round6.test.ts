/**
 * AC18 — regression tests for the defects found by the last verification
 * round.
 *
 *   I1 — a scan RE-ADDED a completed issue: the dedup only looked at the
 *        ACTIVE queue, and a completed issue lives in the history. The next
 *        scan re-queued it and the legacy path ran it a second time — a
 *        second session for the same issue.
 *
 *   I2 — reprocess left the legacy entry 'queued' while the control plane
 *        said 'blocked' (the dependency gate was only applied at
 *        reservation).
 *
 *   I3 — a block raised at RESERVATION (an exceeded token budget) was not
 *        mirrored to the legacy queue.
 *
 *   I4 — reprocess swallowed the stop failure: the host refused to stop
 *        the previous session and a SECOND live session was created.
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
  options: { stopFails?: boolean; settings?: Record<string, unknown> } = {},
) {
  const backing = new Map<string, unknown>()
  const calls: {
    hook: Hook[]
    rpc: Array<{ name: string; fn: (p: unknown, c: unknown) => Promise<unknown> }>
  } = { hook: [], rpc: [] }
  const sessionsCreated: string[] = []
  const stopCalls: string[] = []

  const context = {
    id: 'openfox-automate',
    version: '0.1.0',
    runtime: { mode: 'development' as const, configDirectory: '/tmp/openfox-i' },
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
    if (method === 'POST' && url.endsWith('/stop')) {
      stopCalls.push(url)
      if (options.stopFails) return new Response('refused', { status: 500 })
      return new Response(JSON.stringify({ success: true }), { status: 200 })
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

  return { registry, calls, backing, sessionsCreated, stopCalls, context }
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

describe('AC18 I1 — a completed issue is not re-run by the next scan', () => {
  it('does not re-add it and does not create a second session', async () => {
    const sim = makeSim([{ number: 1, title: 'I1' }])
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))
    const scan = sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!
    await scan.fn({}, sim.registry.context)
    await sim.calls.rpc.find((r) => r.name === 'automate.controlPlaneSchedule')!.fn({}, sim.registry.context)
    expect(sim.sessionsCreated).toHaveLength(1)

    // The issue completes.
    await sim.calls.hook
      .find((h) => h.h === 'workflow.execution.changed')!
      .fn({
        event: 'workflow.execution.changed',
        timestamp: new Date().toISOString(),
        sessionId: 'sess-1',
        data: {
          executionId: 'exec-1',
          workflowId: 'plan-issue-v3',
          workflowName: 'plan-issue-v3',
          status: 'completed',
        },
      })

    // The next scan must not re-queue it.
    await scan.fn({}, sim.registry.context)
    expect(readJson<QueueEntry[]>(sim.backing, 'queue')).toHaveLength(0)
    expect(readJson<QueueEntry[]>(sim.backing, 'history')).toHaveLength(1)

    // And the legacy path must not start it again.
    await sim.calls.hook.find((h) => h.h === 'task.completed')!.fn({})
    expect(sim.sessionsCreated).toHaveLength(1)

    const status = (await sim.calls.rpc
      .find((r) => r.name === 'automate.controlPlaneStatus')!
      .fn({}, sim.registry.context)) as { divergences: string[] }
    expect(status.divergences).toEqual([])
  })
})

describe('AC18 I2 — reprocess applies the dependency gate in both views', () => {
  it('leaves the issue blocked everywhere', async () => {
    const sim = makeSim([{ number: 2, title: 'B', body: 'Depends on #3' }])
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))
    await sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!.fn({}, sim.registry.context)

    const queue = readJson<QueueEntry[]>(sim.backing, 'queue')!
    await sim.calls.rpc
      .find((r) => r.name === 'automate.reprocess')!
      .fn({ queueId: queue[0]!.id }, sim.registry.context)

    expect(controlPlane(sim.backing).items['acme/widgets#2']?.status).toBe('blocked')
    expect(readJson<QueueEntry[]>(sim.backing, 'queue')?.[0]?.status).toBe('blocked')

    const status = (await sim.calls.rpc
      .find((r) => r.name === 'automate.controlPlaneStatus')!
      .fn({}, sim.registry.context)) as { divergences: string[] }
    expect(status.divergences).toEqual([])
  })
})

describe('AC18 I3 — a block raised at reservation is mirrored', () => {
  it('blocks the legacy entry when the token budget is exceeded', async () => {
    const sim = makeSim([{ number: 1, title: 'I1' }], {
      settings: { 'budget.maxTokensPerIssue': 100 },
    })
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))
    await sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!.fn({}, sim.registry.context)

    // The issue already consumed more than the budget.
    const cp = controlPlane(sim.backing)
    const item = cp.items['acme/widgets#1']
    if (!item) throw new Error('the item must exist')
    item.tokens = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 500,
      cachedPromptTokens: 0,
      cacheWriteTokens: 0,
      llmCalls: 1,
    }
    sim.backing.set(CONTROL_PLANE_STORAGE_KEY, JSON.stringify(cp))

    await sim.calls.rpc.find((r) => r.name === 'automate.controlPlaneSchedule')!.fn({}, sim.registry.context)

    expect(controlPlane(sim.backing).items['acme/widgets#1']?.status).toBe('blocked')
    expect(readJson<QueueEntry[]>(sim.backing, 'queue')?.[0]?.status).toBe('blocked')

    const status = (await sim.calls.rpc
      .find((r) => r.name === 'automate.controlPlaneStatus')!
      .fn({}, sim.registry.context)) as { divergences: string[] }
    expect(status.divergences).toEqual([])
  })
})

describe('AC18 I4 — the reprocess fails closed when the session cannot be stopped', () => {
  it('does not start a second live session', async () => {
    const sim = makeSim([{ number: 1, title: 'I1' }], { stopFails: true })
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))
    await sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!.fn({}, sim.registry.context)
    await sim.calls.rpc.find((r) => r.name === 'automate.controlPlaneSchedule')!.fn({}, sim.registry.context)
    expect(sim.sessionsCreated).toHaveLength(1)

    const queue = readJson<QueueEntry[]>(sim.backing, 'queue')!
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

    // The host refuses to stop the previous session: the reprocess must
    // refuse rather than create a second live session.
    await expect(
      sim.calls.rpc
        .find((r) => r.name === 'automate.reprocess')!
        .fn({ queueId: queue[0]!.id }, sim.registry.context),
    ).rejects.toThrow(/could not be stopped/)

    expect(sim.stopCalls.length).toBeGreaterThanOrEqual(1)
    expect(sim.sessionsCreated).toHaveLength(1)
  })
})
