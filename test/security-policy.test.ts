/**
 * AC15 — Security policy and activation.
 *
 * These tests pin the SAFE defaults and the fail-closed behaviour:
 *
 *   - the plugin is INERT by default (dry run on, no startup scan);
 *   - the worker ceiling of 5 is enforced on every path;
 *   - the token budget stops a LIVE run;
 *   - an expired lease BLOCKS the issue instead of starting a second
 *     session for it;
 *   - no GitHub write and no session happens while the dry run is on.
 *
 * Everything is offline: a fake GitHub and a fake host.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { _resetLifecycleForTesting, register } from '../src/index.js'
import {
  DEFAULT_CONTROL_PLANE_OPTIONS,
  admit,
  emptyControlPlaneState,
  markRunning,
  recordTokenUsage,
  reclaimExpiredLeases,
  reserve,
} from '../src/control-plane.js'
import { controlPlaneOptionsFromSettings } from '../src/control-plane-store.js'
import { DEFAULT_SETTINGS } from '../src/types.js'
import { settingsSchema } from '../src/settings.js'
import type { PluginContext, PluginRegistry } from 'openfox/plugin'

const T0 = 1_700_000_000_000

function makeSim(settings: Record<string, unknown> = {}) {
  const backing = new Map<string, unknown>()
  const calls: {
    hook: Array<{ h: string; fn: (p: unknown) => Promise<void> }>
    rpc: Array<{ name: string; fn: (p: unknown, c: unknown) => Promise<unknown> }>
  } = { hook: [], rpc: [] }
  const created: string[] = []
  const launched: string[] = []
  const githubWrites: string[] = []

  const base = {
    'github.token': 'tok',
    'repos.mapping': 'acme/widgets=proj-1',
    'workflows.chain': 'plan-issue-v3\nbuild-verify-v3',
    'scan.startupScan': false,
    'scan.ignoreLabels': '',
    'batch.maxConcurrency': 5,
    'batch.maxConcurrencyPerRepo': 5,
    'ordering.dependencyPattern': '',
    dryRun: false,
    'history.retentionCount': 100,
    'post.closeOnSuccess': false,
    'post.assignOnSuccess': false,
    'post.commentTemplate': '',
    'pr.monitorEnabled': false,
    'budget.maxTokensPerIssue': 0,
    'control.leaseMinutes': 10,
    ...settings,
  }

  const context = {
    id: 'openfox-automate',
    version: '0.1.0',
    runtime: { mode: 'development' as const, configDirectory: '/tmp/openfox-sec' },
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
    settings: vi.fn(() => base),
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
      create: async () => {
        created.push('c')
        return { sessionId: `sess-${created.length}` }
      },
      stop: vi.fn(),
    },
    workflows: {
      launch: (p: { workflowId: string }) => {
        launched.push(p.workflowId)
      },
    },
  }

  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (method !== 'GET') {
      githubWrites.push(`${method} ${url}`)
      return new Response('{}', { status: 200 })
    }
    if (url.includes('/issues?')) {
      return new Response(
        JSON.stringify([
          {
            number: 1,
            title: 'A',
            body: '',
            html_url: 'https://github.com/acme/widgets/issues/1',
            state: 'open',
            labels: [],
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            user: { login: 'r' },
          },
          {
            number: 2,
            title: 'B',
            body: '',
            html_url: 'https://github.com/acme/widgets/issues/2',
            state: 'open',
            labels: [],
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            user: { login: 'r' },
          },
        ]),
        { status: 200 },
      )
    }
    return new Response('{}', { status: 200 })
  })
  vi.stubGlobal('fetch', fetchStub as unknown as typeof fetch)

  return { registry, calls, backing, created, launched, githubWrites, context }
}

afterEach(() => {
  _resetLifecycleForTesting()
  vi.unstubAllGlobals()
})

describe('AC15 — safe defaults', () => {
  it('dry run is ON by default', () => {
    expect(DEFAULT_SETTINGS.dryRun).toBe(true)
    const field = settingsSchema.fields.find((f) => f.key === 'dryRun')
    expect(field?.default).toBe(true)
  })

  it('the startup scan is OFF by default', () => {
    expect(DEFAULT_SETTINGS['scan.startupScan']).toBe(false)
    const field = settingsSchema.fields.find((f) => f.key === 'scan.startupScan')
    expect(field?.default).toBe(false)
  })

  it('no GitHub write is enabled by default', () => {
    expect(DEFAULT_SETTINGS['post.closeOnSuccess']).toBe(false)
    expect(DEFAULT_SETTINGS['post.assignOnSuccess']).toBe(false)
    // `post.commentTemplate` is optional (no default): an empty template
    // means "do not comment".
    const field = settingsSchema.fields.find((f) => f.key === 'post.commentTemplate')
    expect(field?.default ?? '').toBe('')
  })

  it('creates NO session and NO workflow while the dry run is on', async () => {
    const sim = makeSim({ dryRun: true })
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))

    await sim.calls.rpc.find((r) => r.name === 'scan_now')!.fn({}, sim.registry.context)
    await sim.calls.rpc.find((r) => r.name === 'control_plane_schedule')!.fn({}, sim.registry.context)

    expect(sim.created).toHaveLength(0)
    expect(sim.launched).toHaveLength(0)
    expect(sim.githubWrites).toHaveLength(0)
  })
})

describe('AC15 — worker ceiling of 5', () => {
  it('is enforced by the control-plane options even when the settings ask for more', () => {
    const options = controlPlaneOptionsFromSettings({
      'batch.maxConcurrency': 100,
      'batch.maxConcurrencyPerRepo': 100,
    })
    expect(options.maxWorkers).toBe(5)
    expect(options.maxWorkersPerRepo).toBe(5)
    expect(DEFAULT_CONTROL_PLANE_OPTIONS.maxWorkers).toBe(5)
  })

  it('never reserves more than 5 workers', () => {
    const state = emptyControlPlaneState()
    admit(
      state,
      Array.from({ length: 12 }, (_, i) => ({
        repoKey: `acme/r${i}`,
        projectId: 'p',
        issueNumber: i,
        title: 't',
        url: '',
      })),
      { now: T0 },
    )
    const result = reserve(state, {
      ...DEFAULT_CONTROL_PLANE_OPTIONS,
      maxWorkers: 5,
      maxWorkersPerRepo: 5,
      now: T0,
    })
    expect(result.reserved).toHaveLength(5)
  })
})

describe('AC15 — token budget stops a live run', () => {
  it('blocks the running issue when the budget is exceeded', () => {
    const state = emptyControlPlaneState()
    admit(state, [{ repoKey: 'acme/w', projectId: 'p', issueNumber: 1, title: 't', url: '' }], { now: T0 })
    reserve(state, { ...DEFAULT_CONTROL_PLANE_OPTIONS, now: T0 })
    markRunning(state, 'acme/w#1', 'sess-1', { now: T0 })

    recordTokenUsage(state, 'sess-1', { totalTokens: 900 }, { now: T0, maxTokensPerIssue: 1000 })
    expect(state.items['acme/w#1']?.status).toBe('running')

    recordTokenUsage(state, 'sess-1', { totalTokens: 200 }, { now: T0, maxTokensPerIssue: 1000 })
    expect(state.items['acme/w#1']?.status).toBe('blocked')
    expect(state.items['acme/w#1']?.error).toContain('token budget')
  })
})

describe('AC15 — an ambiguous session is blocked, never duplicated', () => {
  it('blocks the issue when its lease expires instead of starting a second session', () => {
    const state = emptyControlPlaneState()
    admit(state, [{ repoKey: 'acme/w', projectId: 'p', issueNumber: 1, title: 't', url: '' }], { now: T0 })
    reserve(state, { ...DEFAULT_CONTROL_PLANE_OPTIONS, leaseMs: 1000, now: T0 })
    markRunning(state, 'acme/w#1', 'sess-1', { now: T0 })

    // The lease expires while the host session may still be running.
    const reclaimed = reclaimExpiredLeases(state, { now: T0 + 2000 })
    expect(reclaimed).toHaveLength(1)
    expect(reclaimed[0]?.status).toBe('blocked')
    expect(reclaimed[0]?.error).toContain('may still be running')

    // The issue is NOT re-reserved: no second session for the same issue.
    const again = reserve(state, { ...DEFAULT_CONTROL_PLANE_OPTIONS, leaseMs: 1000, now: T0 + 2000 })
    expect(again.reserved).toHaveLength(0)
  })

  it('a second scheduler cannot start a second session for the same issue', async () => {
    // ONE issue only, so any second session would be a duplicate.
    const sim = makeSim({ 'scan.ignoreLabels': '' })
    const single = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if ((init?.method ?? 'GET') === 'GET' && url.includes('/issues?')) {
        return new Response(
          JSON.stringify([
            {
              number: 1,
              title: 'A',
              body: '',
              html_url: 'https://github.com/acme/widgets/issues/1',
              state: 'open',
              labels: [],
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
              user: { login: 'r' },
            },
          ]),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', single as unknown as typeof fetch)

    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))
    await sim.calls.rpc.find((r) => r.name === 'scan_now')!.fn({}, sim.registry.context)

    // The control plane starts the issue.
    await sim.calls.rpc.find((r) => r.name === 'control_plane_schedule')!.fn({}, sim.registry.context)
    expect(sim.created).toHaveLength(1)

    // The legacy path is asked to start the SAME issue again.
    const queue = JSON.parse(sim.backing.get('queue') as string) as Array<{ id: string; status: string }>
    const startIssue = sim.calls.rpc.find((r) => r.name === 'start_issue')!
    await expect(startIssue.fn({ queueId: queue[0]!.id }, sim.registry.context)).rejects.toThrow(
      /cannot start entry in status/,
    )

    expect(sim.created).toHaveLength(1)
  })
})
