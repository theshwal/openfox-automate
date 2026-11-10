/**
 * AC10 — Vertical simulation of the whole flow.
 *
 * The scenario:
 *
 *   fake GitHub issue
 *     -> qualification (ignore labels / dedup / ordering)
 *     -> reservation (concurrency limits)
 *     -> mocked session creation
 *     -> workflow launched
 *     -> host `workflow.execution.changed` (completed)
 *     -> next step of the chain launched
 *     -> PR URL captured
 *     -> simulated CI reconciled
 *
 * Everything is deterministic and offline:
 *
 *   - GitHub is a local fake (`fetch` stub) — no network, no real repo.
 *   - The host is a local fake — no OpenFox server, no port, no session.
 *   - No VisiPdP (or any other) session is involved: sessions are
 *     synthetic ids created by the fake.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { _resetLifecycleForTesting, register } from '../src/index.js'
import { monitorPRs } from '../src/pr-monitor.js'
import type { PluginContext, PluginRegistry } from 'openfox/plugin'
import type { QueueEntry } from '../src/types.js'

interface Hook {
  h: string
  fn: (p: unknown) => Promise<void>
}

interface Sim {
  registry: PluginRegistry
  calls: { hook: Hook[]; rpc: Array<{ name: string; fn: (p: unknown, c: unknown) => Promise<unknown> }> }
  backing: Map<string, unknown>
  /** Every workflow the plugin asked the host to launch. */
  launched: Array<{ sessionId: string; workflowId: string; params: Record<string, string> }>
  /** Every HTTP call the plugin made (to GitHub or to the host). */
  httpCalls: string[]
}

const CHAIN = ['plan-issue-v3', 'build-verify-v3', 'publish-pr-v1']

function makeSim(options: { hostAvailable?: boolean } = {}): Sim {
  const calls: Sim['calls'] = { hook: [], rpc: [] }
  const backing = new Map<string, unknown>()
  const launched: Sim['launched'] = []
  const httpCalls: string[] = []

  const context = {
    id: 'openfox-automate',
    version: '0.1.0',
    runtime: { mode: 'development' as const, configDirectory: '/tmp/openfox-sim' },
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
      'github.token': 'test-token',
      'repos.mapping': 'acme/widgets=proj-1',
      'workflows.chain': CHAIN.join('\n'),
      'scan.startupScan': false,
      'scan.ignoreLabels': 'wontfix',
      'batch.maxConcurrency': 5,
      'batch.maxConcurrencyPerRepo': 5,
      'ordering.strategy': 'default',
      'ordering.dependencyPattern': '(#(\\d+))',
      dryRun: false,
      'history.retentionCount': 100,
      'post.closeOnSuccess': false,
      'post.assignOnSuccess': false,
      'post.commentTemplate': '',
      'post.reprocessResetsRetryCount': true,
      'pr.monitorEnabled': true,
      'pr.urlRegex': 'https://github\\.com/[^/]+/[^/]+/pull/(\\d+)',
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

  // The fake host: `context.host` is the facade the plugin looks for. It
  // records the launches instead of contacting any server.
  ;(context as unknown as { host?: unknown }).host = {
    sessions: {
      create: async (_args: { projectId: string; title?: string }) => {
        if (options.hostAvailable === false) {
          throw new Error('host unavailable')
        }
        return { sessionId: `sess-${launched.length + 1}`, workdir: '/tmp/sim' }
      },
      stop: vi.fn(),
    },
    workflows: {
      launch: (p: { sessionId: string; workflowId: string; params?: Record<string, string> }) => {
        launched.push({
          sessionId: p.sessionId,
          workflowId: p.workflowId,
          params: p.params ?? {},
        })
      },
    },
  }

  return { registry, calls, backing, launched, httpCalls }
}

function hookOf(sim: Sim, event: string): (p: unknown) => Promise<void> {
  const found = sim.calls.hook.find((h) => h.h === event)
  if (!found) throw new Error(`hook not registered: ${event}`)
  return found.fn
}

function readJson<T>(backing: Map<string, unknown>, key: string): T | undefined {
  const raw = backing.get(key)
  return raw === undefined ? undefined : (JSON.parse(raw as string) as T)
}

function hostWorkflowEvent(
  sessionId: string,
  data: { executionId: string; workflowId: string; status: string },
): Record<string, unknown> {
  return {
    event: 'workflow.execution.changed',
    timestamp: new Date().toISOString(),
    sessionId,
    data: { ...data, workflowName: data.workflowId },
  }
}

afterEach(() => {
  _resetLifecycleForTesting()
  vi.unstubAllGlobals()
})

describe('AC10 — vertical simulation (no network, no host process)', () => {
  it('runs issue → qualification → reservation → session → workflow → next step → PR → CI', async () => {
    const sim = makeSim()

    // ---- fake GitHub (no network) ----
    const githubFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/user')) {
        return new Response(JSON.stringify({ login: 'bot' }), { status: 200 })
      }
      if (url.includes('/issues?')) {
        return new Response(
          JSON.stringify([
            {
              number: 7,
              title: 'Widget explodes',
              body: 'The widget crashes on startup.',
              html_url: 'https://github.com/acme/widgets/issues/7',
              state: 'open',
              labels: [{ name: 'bug' }],
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
              user: { login: 'reporter' },
            },
            {
              number: 8,
              title: 'Ignored issue',
              body: '',
              html_url: 'https://github.com/acme/widgets/issues/8',
              state: 'open',
              labels: [{ name: 'wontfix' }],
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
              user: { login: 'reporter' },
            },
          ]),
          { status: 200 },
        )
      }
      if (url.includes('/pulls/')) {
        return new Response(
          JSON.stringify({
            number: 42,
            state: 'open',
            merged: false,
            mergeable: true,
            html_url: 'https://github.com/acme/widgets/pull/42',
          }),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', githubFetch as unknown as typeof fetch)

    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))

    // ---- 1. qualification: scan GitHub ----
    const scanNow = sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!
    const scanResult = (await scanNow.fn({}, sim.registry.context)) as {
      added: number
      skipped: number
      errors: string[]
    }
    expect(scanResult.errors).toEqual([])
    // The 'wontfix' issue is filtered out by the ignore-label rule.
    expect(scanResult.added).toBe(1)

    const queued = readJson<QueueEntry[]>(sim.backing, 'queue')!
    expect(queued).toHaveLength(1)
    expect(queued[0]?.issueNumber).toBe(7)
    expect(queued[0]?.status).toBe('queued')

    // ---- 2. reservation: the entry gets a session and the first workflow ----
    const startIssue = sim.calls.rpc.find((r) => r.name === 'automate.startIssue')!
    await startIssue.fn({ queueId: queued[0]!.id }, sim.registry.context)

    expect(sim.launched).toHaveLength(1)
    expect(sim.launched[0]?.workflowId).toBe('plan-issue-v3')
    expect(sim.launched[0]?.params['issue_ref']).toBe('acme/widgets#7')

    const running = readJson<QueueEntry[]>(sim.backing, 'queue')!
    expect(running[0]?.status).toBe('running')
    expect(running[0]?.sessionId).toBe('sess-1')
    expect(running[0]?.executionStack?.[0]?.status).toBe('running')

    // ---- 3. the host reports the first workflow completed ----
    const wfHook = hookOf(sim, 'workflow.execution.changed')
    await wfHook(
      hostWorkflowEvent('sess-1', {
        executionId: 'exec-1',
        workflowId: 'plan-issue-v3',
        status: 'completed',
      }),
    )

    // The chain advanced: exactly ONE new launch, for the next step.
    expect(sim.launched).toHaveLength(2)
    expect(sim.launched[1]?.workflowId).toBe('build-verify-v3')

    const afterFirst = readJson<QueueEntry[]>(sim.backing, 'queue')!
    expect(afterFirst[0]?.executionStack?.[0]?.status).toBe('done')
    expect(afterFirst[0]?.executionStack?.[1]?.status).toBe('running')

    // ---- 4. idempotence: replaying the same event launches nothing ----
    await wfHook(
      hostWorkflowEvent('sess-1', {
        executionId: 'exec-1',
        workflowId: 'plan-issue-v3',
        status: 'completed',
      }),
    )
    expect(sim.launched).toHaveLength(2)

    // ---- 5. second step completes, third step launches ----
    await wfHook(
      hostWorkflowEvent('sess-1', {
        executionId: 'exec-2',
        workflowId: 'build-verify-v3',
        status: 'completed',
      }),
    )
    expect(sim.launched).toHaveLength(3)
    expect(sim.launched[2]?.workflowId).toBe('publish-pr-v1')

    // ---- 6. PR URL captured from the tool output ----
    const toolHook = hookOf(sim, 'tool.completed')
    await toolHook({
      event: 'tool.completed',
      timestamp: new Date().toISOString(),
      sessionId: 'sess-1',
      data: {
        messageId: 'm1',
        toolCallId: 'c1',
        result: {
          success: true,
          output: 'PR opened at https://github.com/acme/widgets/pull/42',
          durationMs: 3,
          truncated: false,
        },
      },
    })
    const withPr = readJson<QueueEntry[]>(sim.backing, 'queue')!
    expect(withPr[0]?.prUrl).toBe('https://github.com/acme/widgets/pull/42')

    // ---- 7. the last workflow completes: the entry is done ----
    await wfHook(
      hostWorkflowEvent('sess-1', {
        executionId: 'exec-3',
        workflowId: 'publish-pr-v1',
        status: 'completed',
      }),
    )
    expect(readJson<QueueEntry[]>(sim.backing, 'queue')).toHaveLength(0)
    const history = readJson<QueueEntry[]>(sim.backing, 'history')!
    expect(history).toHaveLength(1)
    expect(history[0]?.status).toBe('done')
    expect(history[0]?.prUrl).toBe('https://github.com/acme/widgets/pull/42')

    // ---- 8. simulated CI reconciliation (PR mergeable, not merged yet) ----
    const prResult = await monitorPRs({
      token: 'test-token',
      store: {
        loadActive: async () => readJson<QueueEntry[]>(sim.backing, 'queue') ?? [],
        transitionTo: async () => {
          throw new Error('should not transition: the entry is already done')
        },
      } as never,
      notify: vi.fn(),
      republish: vi.fn(),
    })
    expect(prResult.checked).toBe(0)
  })

  it('fails closed when the host cannot create a session: the entry is failed, nothing is launched', async () => {
    const sim = makeSim({ hostAvailable: false })
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))

    const addRaw = sim.calls.rpc.find((r) => r.name === 'automate.addIssueRaw')!
    const added = (await addRaw.fn(
      { repoKey: 'acme/widgets', title: 'Boom', body: '' },
      sim.registry.context,
    )) as QueueEntry

    const startIssue = sim.calls.rpc.find((r) => r.name === 'automate.startIssue')!
    await startIssue.fn({ queueId: added.id }, sim.registry.context)

    // Nothing was launched: the plugin must not pretend it spawned a session.
    expect(sim.launched).toHaveLength(0)
    const entries = readJson<QueueEntry[]>(sim.backing, 'queue')!
    expect(entries[0]?.status).toBe('failed')
    expect(entries[0]?.error).toBeTruthy()
  })

  it('blocks (never "done") when the host cancels the execution', async () => {
    const sim = makeSim()
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))

    const addRaw = sim.calls.rpc.find((r) => r.name === 'automate.addIssueRaw')!
    const added = (await addRaw.fn(
      { repoKey: 'acme/widgets', title: 'Boom', body: '' },
      sim.registry.context,
    )) as QueueEntry
    const startIssue = sim.calls.rpc.find((r) => r.name === 'automate.startIssue')!
    await startIssue.fn({ queueId: added.id }, sim.registry.context)

    await hookOf(
      sim,
      'workflow.execution.changed',
    )(
      hostWorkflowEvent('sess-1', {
        executionId: 'exec-cancel',
        workflowId: 'plan-issue-v3',
        status: 'cancelled',
      }),
    )

    const entries = readJson<QueueEntry[]>(sim.backing, 'queue')!
    const history = readJson<QueueEntry[]>(sim.backing, 'history')!
    const entry = entries[0] ?? history[0]
    expect(entry?.status).toBe('blocked')
    expect(entry?.status).not.toBe('done')
    // No relaunch was attempted for a cancelled execution.
    expect(sim.launched).toHaveLength(1)
  })

  it('respects the concurrency ceiling when several issues are queued', async () => {
    const sim = makeSim()
    // Override the ceiling. The base settings are rebuilt explicitly: a
    // mock's own `mock.results` must never be spread back into its return
    // value (it grows on every call and never terminates).
    ;(sim.registry.context.settings as ReturnType<typeof vi.fn>).mockReturnValue({
      'github.token': 'test-token',
      'repos.mapping': 'acme/widgets=proj-1',
      'workflows.chain': CHAIN.join('\n'),
      'scan.startupScan': false,
      'scan.ignoreLabels': '',
      'batch.maxConcurrency': 1,
      'batch.maxConcurrencyPerRepo': 1,
      'ordering.strategy': 'default',
      'ordering.dependencyPattern': '',
      dryRun: false,
      'history.retentionCount': 100,
      'post.closeOnSuccess': false,
      'post.assignOnSuccess': false,
      'post.commentTemplate': '',
      'post.reprocessResetsRetryCount': true,
      'pr.monitorEnabled': false,
      'pr.urlRegex': '',
    })

    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))

    const addRaw = sim.calls.rpc.find((r) => r.name === 'automate.addIssueRaw')!
    await addRaw.fn({ repoKey: 'acme/widgets', title: 'A', body: '' }, sim.registry.context)
    // `add_issue_raw` derives its issue number from Date.now(), so a second
    // call in the same millisecond would collide with the first one and be
    // deduplicated away. The queue is therefore seeded through the scan
    // path, which carries real issue numbers.
    const githubFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/issues?')) {
        return new Response(
          JSON.stringify([
            {
              number: 12,
              title: 'B',
              body: '',
              html_url: 'https://github.com/acme/widgets/issues/12',
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
    vi.stubGlobal('fetch', githubFetch as unknown as typeof fetch)
    const scanNow = sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!
    await scanNow.fn({}, sim.registry.context)

    // The ceiling is 1, so the CONTROL PLANE owns the scheduling: it
    // reserves and starts exactly one issue. The legacy `startIssue` path
    // must then refuse the other one — that is the guarantee that a single
    // scheduler owns the queue.
    const schedule = sim.calls.rpc.find((r) => r.name === 'automate.controlPlaneSchedule')!
    const scheduled = (await schedule.fn({}, sim.registry.context)) as { started: number }
    expect(scheduled.started).toBe(1)

    // The second issue is still queued: the ceiling of 1 is respected.
    const entries = readJson<QueueEntry[]>(sim.backing, 'queue')!
    expect(entries.filter((e) => e.status === 'running')).toHaveLength(1)
    expect(entries.filter((e) => e.status === 'queued')).toHaveLength(1)

    // Asking the legacy path to start the queued one is refused: the
    // control plane already holds the only slot.
    const queuedEntry = entries.find((e) => e.status === 'queued')!
    const startIssue = sim.calls.rpc.find((r) => r.name === 'start_issue')!
    await expect(startIssue.fn({ queueId: queuedEntry.id }, sim.registry.context)).rejects.toThrow(
      /already reserved by the control plane/,
    )
  })
})
