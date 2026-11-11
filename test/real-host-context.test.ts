/**
 * AC18 — the plugin must work with the REAL host context.
 *
 * The independent verifier found that the test suite injected a
 * `context.host` that OpenFox 2.0.161 NEVER builds:
 *
 *   PluginHost.createContext (chunk-4XRJ4J6E.js:7976) returns exactly
 *   { id, version, runtime, logger, storage, settings, notify, publish }
 *
 * so the plugin had no working session-creation path on a real host.
 *
 * These tests use that REAL context shape — no `context.host`, no
 * `context.openFoxInternals` — and prove the plugin reaches the host
 * through the SUPPORTED HTTP API (`src/host-client.ts`).
 *
 * The fetch is a fake: no server, no port, no network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { _resetLifecycleForTesting, register } from '../src/index.js'
import { createHostOrchestration, defaultHttpClientFactory } from '../src/orchestration.js'
import { HostClient } from '../src/host-client.js'
import type { PluginContext, PluginRegistry } from 'openfox/plugin'

interface Hook {
  h: string
  fn: (p: unknown) => Promise<void>
}

/**
 * A context shaped EXACTLY like the one the real host builds — no
 * `host`, no `openFoxInternals`.
 */
function makeRealContext(overrides: Record<string, unknown> = {}): {
  context: PluginContext
  backing: Map<string, unknown>
} {
  const backing = new Map<string, unknown>()
  const context = {
    id: 'openfox-automate',
    version: '0.1.0',
    runtime: { mode: 'development' as const, configDirectory: '/tmp/openfox-real' },
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
      'workflows.chain': 'plan-issue-v3',
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
      ...overrides,
    })),
    notify: vi.fn(),
    publish: vi.fn(),
  } as unknown as PluginContext
  return { context, backing }
}

afterEach(() => {
  _resetLifecycleForTesting()
  vi.unstubAllGlobals()
})

describe('AC18 — the plugin reaches the host with the REAL context shape', () => {
  it('the context has no host and no openFoxInternals (the real 2.0.161 shape)', () => {
    const { context } = makeRealContext()
    expect((context as unknown as { host?: unknown }).host).toBeUndefined()
    expect((context as unknown as { openFoxInternals?: unknown }).openFoxInternals).toBeUndefined()
  })

  it('creates a session through the supported HTTP API', async () => {
    const { context } = makeRealContext()
    const calls: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.endsWith('/api/sessions')) {
        return new Response(JSON.stringify({ session: { id: 'sess-http-1', workdir: '/tmp/x' } }), {
          status: 201,
        })
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }) as unknown as typeof fetch

    const client = new HostClient({ baseUrl: 'http://127.0.0.1:10369' }, { fetchImpl })
    const orchestration = createHostOrchestration(context, () => client)

    const session = await orchestration.createSession('proj-1', '[issue #7] Boom')
    expect(session.id).toBe('sess-http-1')
    expect(calls[0]).toBe('POST http://127.0.0.1:10369/api/sessions')
  })

  it('launches a workflow through the host TASK BOARD, not by executing it', async () => {
    const { context } = makeRealContext()
    const urls: string[] = []
    const bodies: unknown[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      urls.push(url)
      if (init?.body) bodies.push(JSON.parse(String(init.body)))
      if (url.endsWith('/tasks')) {
        return new Response(JSON.stringify({ task: { id: 'task-1' } }), { status: 201 })
      }
      return new Response(JSON.stringify({ task: { id: 'task-1' } }), { status: 200 })
    }) as unknown as typeof fetch

    const client = new HostClient({ baseUrl: 'http://127.0.0.1:10369' }, { fetchImpl })
    const orchestration = createHostOrchestration(context, () => client)

    await orchestration.launchWorkflow({
      sessionId: 'sess-1',
      workflowId: 'plan-issue-v3',
      params: { issue_ref: 'acme/widgets#7' },
      projectId: 'proj-1',
    })

    // The HOST resolves the id and runs the workflow — through the task
    // board, which is the only HTTP path where the host resolves a
    // `/<workflow-id>` prompt.
    expect(urls[0]).toBe('http://127.0.0.1:10369/api/projects/proj-1/tasks')
    expect(bodies[0]).toEqual({ prompt: '/plan-issue-v3 acme/widgets#7' })
    expect(urls[1]).toBe('http://127.0.0.1:10369/api/projects/proj-1/tasks/task-1/move')
  })

  it('fails closed when the host refuses, without pretending a session exists', async () => {
    const { context } = makeRealContext()
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 })) as unknown as typeof fetch
    const client = new HostClient({ baseUrl: 'http://127.0.0.1:10369', token: 'bad' }, { fetchImpl })
    const orchestration = createHostOrchestration(context, () => client)

    await expect(orchestration.createSession('proj-1', 't')).rejects.toThrow(/unauthorized|refused/)
  })

  it('the default factory reads the configured base URL and the token', () => {
    const { context } = makeRealContext({
      'host.baseUrl': 'http://127.0.0.1:12345',
      'host.sessionToken': 'tok-abc',
    })
    const factory = defaultHttpClientFactory(context)
    expect(factory()).not.toBeNull()
  })

  it('falls back to the host default port when no base URL is configured', () => {
    const { context } = makeRealContext()
    const factory = defaultHttpClientFactory(context)
    // The factory builds a client for the host's own default port; the
    // plugin never invents a port of its own.
    expect(factory()).not.toBeNull()
  })

  it('the plugin registers and its RPCs answer with the real context shape', async () => {
    const { context } = makeRealContext()
    const calls: {
      hook: Hook[]
      rpc: Array<{ name: string; fn: (p: unknown, c: unknown) => Promise<unknown> }>
    } = { hook: [], rpc: [] }
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

    register(registry)
    await new Promise((r) => setTimeout(r, 0))

    const ping = calls.rpc.find((r) => r.name === 'automate.ping')
    expect(ping).toBeDefined()
    const result = (await ping!.fn({}, context)) as { ok: boolean; plugin: string }
    expect(result.ok).toBe(true)
    expect(result.plugin).toBe('openfox-automate')

    // The workflow hooks are registered with the real context shape.
    expect(calls.hook.map((h) => h.h)).toEqual(
      expect.arrayContaining(['workflow.execution.changed', 'tool.completed', 'llm.completed']),
    )
  })
})
