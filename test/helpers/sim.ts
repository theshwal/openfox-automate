/**
 * The SHARED test harness.
 *
 * Before this module every regression file carried its own ~100-line
 * `makeSim()`: a fake PluginContext, a fake registry, a fake GitHub and
 * a fake host HTTP API, each with slightly different settings and
 * slightly different fake behaviours. The same scenario had to be
 * re-implemented for every round, which is the main maintainability cost
 * of the branch (finding #26).
 *
 * This harness exposes ONE simulation with options for the variations
 * the scenarios need. It stays offline: the GitHub API and the OpenFox
 * host are faked in-process, no server is started and no port is
 * contacted.
 */

import { vi } from 'vitest'

import type { PluginContext, PluginRegistry } from 'openfox/plugin'

export interface SimIssue {
  number: number
  title: string
  body?: string
  labels?: string[]
  comments?: Array<{ body: string; user?: { login: string } }>
}

export interface SimWorkflow {
  id: string
  /** The DECLARED parameters, in the order the host expects them. */
  parameters?: Array<{ id: string; position?: number; required?: boolean }>
}

export interface SimOptions {
  /** The issues the fake GitHub returns. */
  issues?: SimIssue[]
  /** Settings overrides. */
  settings?: Record<string, unknown>
  /** The workflow chain (defaults to the three v3 workflows). */
  chain?: string[]
  /** The host rejects every request when false. */
  hostReachable?: boolean
  /** The host refuses to stop the session when true. */
  stopFails?: boolean
  /** The workflows the host knows, with their declared parameters. */
  workflows?: SimWorkflow[]
  /** The fake GitHub reports the pull request as merged. */
  prMerged?: boolean
  /**
   * Install the in-process host facade (`context.host`), as a host that
   * supports plugin orchestration does. The plugin then uses it INSTEAD
   * of the HTTP path.
   */
  inProcessFacade?: boolean
  /** The chain used by `plan-issue-v3` etc. is irrelevant here. */
  ignoreLabels?: string
}

export interface HostCall {
  method: string
  url: string
  body: unknown
}

export interface Sim {
  registry: PluginRegistry
  calls: {
    hook: Array<{ h: string; fn: (p: unknown) => Promise<void> }>
    rpc: Array<{ name: string; fn: (p: unknown, c: unknown) => Promise<unknown> }>
  }
  backing: Map<string, unknown>
  /** Every host HTTP call, in order. */
  hostCalls: HostCall[]
  /** The ids of the sessions the fake host created. */
  sessions: string[]
  /** The prompts the plugin submitted to the host's task board. */
  launchedPrompts: string[]
  /** The sessions the plugin asked to stop. */
  stopCalls: string[]
  /** The GitHub write requests (comments, assignment, close). */
  githubWrites: string[]
  /** Issue numbers the fake GitHub no longer returns (closed upstream). */
  closedIssues: number[]
  /** The in-process launches, when the fake host facade is installed. */
  inProcessLaunches: Array<{ sessionId: string; workflowId: string }>
  context: PluginContext
  logger: {
    debug: ReturnType<typeof vi.fn>
    info: ReturnType<typeof vi.fn>
    warn: ReturnType<typeof vi.fn>
    error: ReturnType<typeof vi.fn>
  }
  /** Replace the settings the plugin reads (after the simulation was built). */
  setSettings(settings: Record<string, unknown>): void
}

const DEFAULT_CHAIN = ['plan-issue-v3', 'build-verify-v3', 'publish-pr-v1']

const DEFAULT_WORKFLOWS: SimWorkflow[] = [
  {
    id: 'plan-issue-v3',
    parameters: [
      { id: 'issue_ref', position: 0, required: true },
      { id: 'repo', position: 1, required: false },
    ],
  },
  { id: 'build-verify-v3', parameters: [] },
  { id: 'publish-pr-v1', parameters: [] },
]

/** The default settings: a working plugin with safe defaults. */
export function defaultSettings(options: SimOptions = {}): Record<string, unknown> {
  return {
    'github.token': 'tok',
    'repos.mapping': 'acme/widgets=proj-1',
    'workflows.chain': (options.chain ?? DEFAULT_CHAIN).join('\n'),
    'scan.startupScan': false,
    'scan.ignoreLabels': options.ignoreLabels ?? '',
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
  }
}

function githubIssue(issue: SimIssue): Record<string, unknown> {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    html_url: `https://github.com/acme/widgets/issues/${issue.number}`,
    state: 'open',
    labels: (issue.labels ?? []).map((name) => ({ name })),
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    user: { login: 'r' },
  }
}

/**
 * Build the simulation.
 *
 * The fake host reproduces the REAL 2.0.161 answers: the task board
 * reports the session it bound to the task, the workflow metadata is
 * served with the DECLARED parameter positions, and the task board
 * accepts a slot-limit change.
 */
export function makeSim(options: SimOptions = {}): Sim {
  const issues = options.issues ?? []
  const backing = new Map<string, unknown>()
  const calls: {
    hook: Array<{ h: string; fn: (p: unknown) => Promise<void> }>
    rpc: Array<{ name: string; fn: (p: unknown, c: unknown) => Promise<unknown> }>
  } = { hook: [], rpc: [] }
  const hostCalls: HostCall[] = []
  const sessions: string[] = []
  const launchedPrompts: string[] = []
  const stopCalls: string[] = []
  const githubWrites: string[] = []
  const closedIssues: number[] = []
  const inProcessLaunches: Array<{ sessionId: string; workflowId: string }> = []
  const workflows = options.workflows ?? DEFAULT_WORKFLOWS
  let sessionCounter = 0
  let taskCounter = 0
  let settings: Record<string, unknown> = defaultSettings(options)

  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }

  const context = {
    id: 'openfox-automate',
    version: '0.1.0',
    runtime: { mode: 'development' as const, configDirectory: '/tmp/openfox-sim' },
    logger,
    storage: {
      get: vi.fn(async (k: string) => {
        const raw = backing.get(k)
        return raw === undefined ? undefined : (JSON.parse(raw as string) as unknown)
      }),
      set: vi.fn(async (k: string, v: unknown) => {
        backing.set(k, JSON.stringify(v))
      }),
    },
    settings: vi.fn(() => settings),
    notify: vi.fn(),
    publish: vi.fn(),
  } as unknown as PluginContext

  if (options.inProcessFacade) {
    // A host that supports plugin orchestration exposes `context.host`.
    ;(context as unknown as { host?: unknown }).host = {
      sessions: {
        create: async () => {
          sessionCounter += 1
          sessions.push(`sess-${sessionCounter}`)
          return { sessionId: `sess-${sessionCounter}` }
        },
        stop: vi.fn(),
      },
      workflows: {
        launch: (p: { sessionId: string; workflowId: string }) => {
          inProcessLaunches.push({ sessionId: p.sessionId, workflowId: p.workflowId })
        },
      },
    }
  }

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
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    hostCalls.push({ method, url, body })

    // --- GitHub (fake) ---
    if (url.includes('api.github.com')) {
      if (method === 'GET' && url.includes('/issues?')) {
        return new Response(
          JSON.stringify(issues.filter((i) => !closedIssues.includes(i.number)).map(githubIssue)),
          { status: 200 },
        )
      }
      if (method === 'GET' && url.includes('/issues/')) {
        const number = Number(url.split('/issues/')[1]?.split('?')[0])
        const issue = issues.find((i) => i.number === number)
        if (!issue) return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404 })
        return new Response(JSON.stringify(githubIssue(issue)), { status: 200 })
      }
      if (method === 'GET' && url.includes('/comments')) {
        const issue = issues.find((i) => url.includes(`/issues/${i.number}`))
        return new Response(JSON.stringify(issue?.comments ?? []), { status: 200 })
      }
      if (method !== 'GET') {
        githubWrites.push(`${method} ${url}`)
        return new Response(JSON.stringify({ success: true }), { status: 200 })
      }
      return new Response(JSON.stringify({}), { status: 200 })
    }

    // --- The OpenFox host (fake) ---
    if (options.hostReachable === false) {
      return new Response('unreachable', { status: 500 })
    }
    if (method === 'GET' && url.endsWith('/api/workflows')) {
      return new Response(
        JSON.stringify({
          defaults: [],
          userItems: workflows,
          projectItems: [],
        }),
        { status: 200 },
      )
    }
    if (method === 'GET' && url.includes('/pulls/')) {
      return new Response(
        JSON.stringify({ merged: options.prMerged === true, state: options.prMerged ? 'closed' : 'open' }),
        { status: 200 },
      )
    }
    if (method !== 'GET' && url.endsWith('/api/sessions')) {
      sessionCounter += 1
      sessions.push(`sess-${sessionCounter}`)
      return new Response(JSON.stringify({ session: { id: `sess-${sessionCounter}` } }), { status: 201 })
    }
    if (method === 'POST' && url.endsWith('/api/sessions/sess-1/stop')) {
      stopCalls.push('sess-1')
      if (options.stopFails) return new Response(JSON.stringify({ error: 'nope' }), { status: 500 })
      return new Response(JSON.stringify({ success: true, queuedMessages: [] }), { status: 200 })
    }
    if (method === 'POST' && url.includes('/api/sessions/') && url.endsWith('/stop')) {
      const id = url.split('/api/sessions/')[1]!.replace('/stop', '')
      stopCalls.push(id)
      if (options.stopFails) return new Response(JSON.stringify({ error: 'nope' }), { status: 500 })
      return new Response(JSON.stringify({ success: true, queuedMessages: [] }), { status: 200 })
    }
    if (method === 'PUT' && url.endsWith('/tasks/settings')) {
      return new Response(
        JSON.stringify({ settings: { slotLimit: (body as { slotLimit?: number })?.slotLimit ?? 1 } }),
        {
          status: 200,
        },
      )
    }
    if (method === 'POST' && url.endsWith('/tasks')) {
      taskCounter += 1
      const prompt = (body as { prompt?: string })?.prompt ?? ''
      launchedPrompts.push(prompt)
      return new Response(JSON.stringify({ task: { id: `task-${taskCounter}` } }), { status: 201 })
    }
    if (method === 'POST' && url.includes('/move')) {
      // The host reports the session it bound to the task.
      return new Response(
        JSON.stringify({
          task: { id: `task-${taskCounter}`, runState: 'running' },
          sessionId: sessions[sessions.length - 1],
        }),
        { status: 200 },
      )
    }
    if (method === 'DELETE' && url.includes('/tasks/')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchStub as unknown as typeof fetch)

  return {
    registry,
    calls,
    backing,
    hostCalls,
    sessions,
    launchedPrompts,
    stopCalls,
    githubWrites,
    closedIssues,
    inProcessLaunches,
    context,
    logger,
    setSettings: (next: Record<string, unknown>) => {
      settings = next
    },
  }
}

/** Read a JSON value from the plugin's storage. */
export function readJson<T>(backing: Map<string, unknown>, key: string): T | undefined {
  const raw = backing.get(key)
  return raw === undefined ? undefined : (JSON.parse(raw as string) as T)
}

/** Let the asynchronous launch settle. */
export async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

/** The RPC registered under that name. */
export function rpc(sim: Sim, name: string): (p: unknown, c: unknown) => Promise<unknown> {
  const found = sim.calls.rpc.find((r) => r.name === name)
  if (!found) throw new Error(`the RPC "${name}" is not registered`)
  return found.fn
}

/** The hook registered under that name. */
export function hook(sim: Sim, name: string): (p: unknown) => Promise<void> {
  const found = sim.calls.hook.find((h) => h.h === name)
  if (!found) throw new Error(`the hook "${name}" is not registered`)
  return found.fn
}
