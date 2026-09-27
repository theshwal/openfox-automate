import { describe, expect, it, vi } from 'vitest'

import { register } from '../src/index.js'
import { settingsSchema } from '../src/settings.js'
import type { PluginContext, PluginRegistry } from 'openfox/plugin'

interface FakeCalls {
  tool: unknown[]
  command: unknown[]
  skillSource: unknown[]
  settings: unknown[]
  uiAction: unknown[]
  uiBadge: unknown[]
  uiPanel: unknown[]
  hook: unknown[]
  transition: unknown[]
  rpc: Array<{ name: string; fn: (params: unknown, ctx: unknown) => Promise<unknown> }>
  asset: unknown[]
}

function makeFakeRegistry(): { registry: PluginRegistry; calls: FakeCalls } {
  const calls: FakeCalls = {
    tool: [],
    command: [],
    skillSource: [],
    settings: [],
    uiAction: [],
    uiBadge: [],
    uiPanel: [],
    hook: [],
    transition: [],
    rpc: [],
    asset: [],
  }

  const context = {
    id: 'openfox-automate',
    version: '0.1.0',
    runtime: { mode: 'development' as const, configDirectory: '/tmp/openfox' },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    storage: { get: vi.fn(async () => undefined), set: vi.fn(async () => undefined) },
    settings: vi.fn(() => ({})),
    notify: vi.fn(),
    publish: vi.fn(),
  } as unknown as PluginContext

  const registry = {
    context,
    registerTool: (t: unknown) => calls.tool.push(t),
    registerCommand: (c: unknown) => calls.command.push(c),
    registerSkillSource: (s: unknown) => calls.skillSource.push(s),
    registerSettings: (s: unknown) => calls.settings.push(s),
    registerUiAction: (a: unknown) => calls.uiAction.push(a),
    registerUiBadge: (b: unknown) => calls.uiBadge.push(b),
    registerUiPanel: (p: unknown) => calls.uiPanel.push(p),
    registerHook: (h: string, fn: unknown) => calls.hook.push({ h, fn }),
    registerTransitionHandler: (name: string, fn: unknown) => calls.transition.push({ name, fn }),
    registerRpc: (name: string, fn: (params: unknown, ctx: unknown) => Promise<unknown>) =>
      calls.rpc.push({ name, fn }),
    registerAsset: (a: unknown) => calls.asset.push(a),
    registerAuth: vi.fn(),
    registerTransport: vi.fn(),
    registerPreset: vi.fn(),
    registerModelMetadataProvider: vi.fn(),
  } as unknown as PluginRegistry

  return { registry, calls }
}

describe('openfox-automate (stub build)', () => {
  it('register() wires up settings + RPCs + UI + hooks + tools without throwing', () => {
    const { registry, calls } = makeFakeRegistry()

    expect(() => register(registry)).not.toThrow()

    expect(calls.settings).toHaveLength(1)
    const rpcNames = calls.rpc.map((r) => r.name)
    expect(rpcNames).toEqual(
      expect.arrayContaining([
        'ping',
        'scan_now',
        'health',
        'get_queue',
        'get_history',
        'get_metrics',
        'start_issue',
        'cancel_issue',
        'remove_issue',
        'reprocess',
        'add_issue_by_url',
        'add_issue_raw',
        'pause_auto_scan',
        'resume_auto_scan',
      ]),
    )
    expect(calls.uiAction).toHaveLength(1)
    expect(calls.uiPanel).toHaveLength(1)
    expect(calls.uiAction[0]).toMatchObject({ slot: 'header.actions' })
    expect(calls.uiPanel[0]).toMatchObject({ id: 'issue-queue-panel', kind: 'iframe' })
    const hookEvents = calls.hook.map((h) => (h as { h: string }).h)
    expect(hookEvents).toEqual(expect.arrayContaining(['workflow.execution.changed', 'task.completed']))
    expect(calls.tool.map((t) => (t as { name: string }).name)).toEqual(
      expect.arrayContaining(['issue_queue_list', 'issue_queue_status']),
    )
  })

  it('settings schema exposes the documented keys', () => {
    const keys = settingsSchema.fields.map((f: { key: string }) => f.key)
    expect(keys).toEqual(
      expect.arrayContaining([
        'github.token',
        'repos.mapping',
        'workflows.chain',
        'workflows.repoOverrides',
        'scan.refreshMinutes',
        'scan.startupScan',
        'scan.ignoreLabels',
        'batch.maxConcurrency',
        'batch.maxConcurrencyPerRepo',
        'ordering.strategy',
        'ordering.dependencyPattern',
        'dryRun',
        'history.retentionCount',
        'post.closeOnSuccess',
        'post.assignOnSuccess',
        'post.commentTemplate',
        'post.reprocessResetsRetryCount',
        'pr.monitorEnabled',
        'pr.urlRegex',
      ]),
    )
  })

  it('ping RPC returns ok + plugin id + version + timestamp', async () => {
    const { registry, calls } = makeFakeRegistry()
    register(registry)

    const ping = calls.rpc[0]
    expect(ping).toBeDefined()
    const result = await ping.fn({}, {})
    expect(result).toMatchObject({ ok: true, plugin: 'openfox-automate', version: '0.1.0' })
    expect(typeof (result as { timestamp: string }).timestamp).toBe('string')
  })

  it('tool.completed hook captures GitHub PR URLs into the matching entry', async () => {
    const { registry, calls } = makeFakeRegistry()
    const backing = new Map<string, unknown>()
    registry.context.storage = {
      get: vi.fn(async (k: string) => backing.get(k)),
      set: vi.fn(async (k: string, v: unknown) => {
        backing.set(k, v)
      }),
    } as unknown as PluginContext['storage']
    registry.context.settings = vi.fn(() => ({
      'repos.mapping': 'o/r=p1',
    })) as unknown as PluginContext['settings']

    register(registry)

    const hook = calls.hook.find((h) => (h as { h: string }).h === 'tool.completed')
    expect(hook).toBeDefined()
    const fn = (hook as { fn: (p: unknown) => Promise<void> }).fn

    const addRaw = calls.rpc.find((r) => r.name === 'add_issue_raw')
    expect(addRaw).toBeDefined()
    await addRaw!.fn({ repoKey: 'o/r', title: 'T', body: '' }, {})

    const stored = backing.get('queue') as Array<{ id: string; sessionId?: string; prUrl?: string }>
    expect(stored).toBeDefined()
    const sessionId = 'sess-pr'
    stored[0]!.sessionId = sessionId
    backing.set('queue', stored)

    await fn({
      sessionId,
      output: 'Opened https://github.com/o/r/pull/42 — please review',
    })

    const after = backing.get('queue') as Array<{ prUrl?: string }>
    expect(after[0]?.prUrl).toBe('https://github.com/o/r/pull/42')
  })
})
