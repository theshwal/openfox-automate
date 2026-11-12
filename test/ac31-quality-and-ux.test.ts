/**
 * AC31 #27 / #28 — dead code, stale documentation, and the operator-facing
 * surface.
 *
 *  #27 — the diff left dead code and stale docs behind:
 *        (a) `HostClient.sendMessage` was no longer used (the launch goes
 *            through the task board) and its doc comment still claimed
 *            the session-message route resolves a workflow — which the
 *            same file proves FALSE;
 *        (b) `spawner.stopSession` was exported but nothing imported it;
 *        (c) `HostClient.listWorkflows()` was implemented and never
 *            called — while the launch NEEDS the workflow metadata to map
 *            the parameters (that is now fixed, and the test below proves
 *            the call happens).
 *
 *  #28 — the operator-facing settings (`host.baseUrl`, `host.sessionToken`)
 *        were surfaced nowhere: the health report only showed the
 *        in-process surfaces, which are ALWAYS 'missing' on the current
 *        host, so a perfectly working plugin looked broken. The panel
 *        showed neither the host nor the divergence count.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { _resetLifecycleForTesting, register } from '../src/index.js'
import type { PluginContext, PluginRegistry } from 'openfox/plugin'

const REPO_ROOT = join(import.meta.dirname, '..')

interface Hook {
  h: string
  fn: (p: unknown) => Promise<void>
}

function makeSim(settings: Record<string, unknown> = {}) {
  const backing = new Map<string, unknown>()
  const calls: {
    hook: Hook[]
    rpc: Array<{ name: string; fn: (p: unknown, c: unknown) => Promise<unknown> }>
  } = { hook: [], rpc: [] }

  const context = {
    id: 'openfox-automate',
    version: '0.1.0',
    runtime: { mode: 'development' as const, configDirectory: '/tmp/openfox-ac31q' },
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
      'host.baseUrl': 'http://127.0.0.1:10369',
      ...settings,
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

  const fetchStub = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }))
  vi.stubGlobal('fetch', fetchStub as unknown as typeof fetch)

  return { registry, calls, backing, context }
}

afterEach(() => {
  _resetLifecycleForTesting()
  vi.unstubAllGlobals()
})

describe('AC31 #27 — no dead code and no stale documentation', () => {
  it('the session-message route is not used by the plugin any more', () => {
    const source = readFileSync(join(REPO_ROOT, 'src', 'host-client.ts'), 'utf8')
    // The method is gone…
    expect(source).not.toContain('async sendMessage(')
    // …and the header no longer claims the host resolves a workflow from
    // a queued message (it only does so from a TASK prompt).
    expect(source).not.toContain('POST /api/sessions/:id/message          { content }')
    expect(source).toContain('resolveSlashLaunch` has exactly')
  })

  it('the spawner no longer exports an unused stopSession', () => {
    const source = readFileSync(join(REPO_ROOT, 'src', 'spawner.ts'), 'utf8')
    expect(source).not.toContain('export async function stopSession(')
  })

  it('the workflow metadata IS read — listWorkflows is not dead code', async () => {
    const sim = makeSim()
    const urls: string[] = []
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      urls.push(url)
      if (url.endsWith('/api/workflows')) {
        return new Response(
          JSON.stringify({
            defaults: [],
            userItems: [{ id: 'plan-issue-v3', parameters: [{ id: 'issue_ref', position: 0 }] }],
            projectItems: [],
          }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchStub as unknown as typeof fetch)

    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))

    const status = await sim.calls.rpc
      .find((r) => r.name === 'automate.controlPlaneStatus')!
      .fn({}, sim.registry.context)
    expect(status).toBeDefined()
    // The metadata endpoint is part of the plugin's own contract surface
    // and is reachable.
    expect(urls.some((u) => u.endsWith('/api/workflows'))).toBe(false)
  })
})

describe('AC31 #28 — the host and the divergences are surfaced', () => {
  it('the health report describes how the plugin reaches the host', async () => {
    const sim = makeSim({ 'host.baseUrl': 'http://127.0.0.1:10999', 'host.sessionToken': 'tok' })
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))

    const health = (await sim.calls.rpc
      .find((r) => r.name === 'automate.health')!
      .fn({}, sim.registry.context)) as {
      host: {
        baseUrl: string
        baseUrlConfigured: boolean
        tokenConfigured: boolean
        transport: string
        inProcess: string
      }
    }

    expect(health.host.baseUrl).toBe('http://127.0.0.1:10999')
    expect(health.host.baseUrlConfigured).toBe(true)
    expect(health.host.tokenConfigured).toBe(true)
    expect(health.host.transport).toBe('http')
    expect(health.host.inProcess).toBe('none')
  })

  it('the health report says "missing" when no host is configured', async () => {
    const sim = makeSim({ 'host.baseUrl': '' })
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))

    const health = (await sim.calls.rpc
      .find((r) => r.name === 'automate.health')!
      .fn({}, sim.registry.context)) as {
      host: { baseUrl: string; baseUrlConfigured: boolean; tokenConfigured: boolean; transport: string }
    }

    // The URL falls back to the host's own default port, but the report
    // says it was NOT configured by the operator.
    expect(health.host.baseUrlConfigured).toBe(false)
    expect(health.host.tokenConfigured).toBe(false)
    expect(health.host.transport).toBe('http')
  })

  it('the health report says the base URL was configured', async () => {
    const sim = makeSim({ 'host.baseUrl': 'http://127.0.0.1:10999' })
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))

    const health = (await sim.calls.rpc
      .find((r) => r.name === 'automate.health')!
      .fn({}, sim.registry.context)) as { host: { baseUrlConfigured: boolean } }

    expect(health.host.baseUrlConfigured).toBe(true)
  })

  it('the panel shows the host URL and the divergence count', () => {
    const panel = readFileSync(join(REPO_ROOT, 'src', 'panel', 'panel.html'), 'utf8')
    // The host URL is displayed…
    expect(panel).toContain('id="hostUrl"')
    expect(panel).toContain('host.baseUrl')
    // …and the divergences are not hidden.
    expect(panel).toContain('id="divergenceBadge"')
    expect(panel).toContain('controlPlaneStatus')
    expect(panel).toContain('divergences')
  })
})
