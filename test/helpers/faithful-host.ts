/**
 * A FAITHFUL model of the OpenFox 2.0.161 host.
 *
 * The shared harness (`test/helpers/sim.ts`) answers "does the plugin call
 * the right endpoints?". This one answers the harder question: "does the
 * chain ACTUALLY run against a host that behaves like the real one?".
 *
 * It reproduces the three host behaviours that broke the launch path:
 *
 *  1. `reusableTarget` only reuses a session that has NO MESSAGES
 *     (host chunk-Q54OOZ5U.js:865). So from the SECOND chain step on, the
 *     host necessarily SEEDS A NEW SESSION and reports it.
 *  2. The host only frees a worker slot when its task leaves
 *     "in_progress" (`moveLocked` counts the running tasks). A task left
 *     there consumes the slot FOREVER.
 *  3. `getTaskSettings` defaults `slotLimit` to ONE, and the host
 *     QUEUES the task when the limit is reached (`runState: 'queued'`).
 *
 * The model keeps the tasks in memory, so a test can assert that the
 * host's slots are actually released — the defect that made the second
 * issue never start.
 */

import { vi } from 'vitest'

import type { PluginContext, PluginRegistry } from 'openfox/plugin'

export interface FaithfulHostOptions {
  issues?: Array<{ number: number; title: string; body?: string }>
  settings?: Record<string, unknown>
  chain?: string[]
  /** The chain the host runs, by workflow id. */
  workflows?: Array<{ id: string; parameters?: Array<{ id: string; position?: number }> }>
  /** The host's own slot limit (the real default is ONE). */
  slotLimit?: number
  /** The session the host binds to the FIRST launch of an issue. */
  seedSessionPerLaunch?: boolean
}

export interface HostTask {
  id: string
  prompt: string
  state: 'todo' | 'in_progress' | 'done'
  runState: 'queued' | 'running' | 'idle'
  sessionId?: string
}

export interface FaithfulSim {
  registry: PluginRegistry
  calls: {
    hook: Array<{ h: string; fn: (p: unknown) => Promise<void> }>
    rpc: Array<{ name: string; fn: (p: unknown, c: unknown) => Promise<unknown> }>
  }
  backing: Map<string, unknown>
  /** The tasks the host currently holds. */
  tasks: HostTask[]
  /** The tasks that are still in_progress — they hold the host's slots. */
  activeTaskCount(): number
  /** The sessions the host created, in order. */
  sessions: string[]
  /** The prompt of every task, in order. */
  prompts: string[]
  /** The HTTP calls, in order. */
  hostCalls: Array<{ method: string; url: string; body: unknown }>
  context: PluginContext
  logger: {
    debug: ReturnType<typeof vi.fn>
    info: ReturnType<typeof vi.fn>
    warn: ReturnType<typeof vi.fn>
    error: ReturnType<typeof vi.fn>
  }
}

const DEFAULT_CHAIN = ['plan-issue-v3', 'build-verify-v3', 'publish-pr-v1']

/**
 * Build a simulation backed by the faithful host model.
 */
export function makeFaithfulSim(options: FaithfulHostOptions = {}): FaithfulSim {
  const issues = options.issues ?? []
  const chain = options.chain ?? DEFAULT_CHAIN
  const backing = new Map<string, unknown>()
  const calls: {
    hook: Array<{ h: string; fn: (p: unknown) => Promise<void> }>
    rpc: Array<{ name: string; fn: (p: unknown, c: unknown) => Promise<unknown> }>
  } = { hook: [], rpc: [] }
  const tasks: HostTask[] = []
  const sessions: string[] = []
  const prompts: string[] = []
  const hostCalls: Array<{ method: string; url: string; body: unknown }> = []
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

  // The host's task-board settings. The real default is ONE.
  let slotLimit = options.slotLimit ?? 1
  let sessionCounter = 0
  let taskCounter = 0
  // The sessions the host already "used" (i.e. that already have
  // messages): they can never be reused.
  const usedSessions = new Set<string>()

  const settings: Record<string, unknown> = {
    'github.token': 'tok',
    'repos.mapping': 'acme/widgets=proj-1',
    'workflows.chain': chain.join('\n'),
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
  }

  const context = {
    id: 'openfox-automate',
    version: '0.1.0',
    runtime: { mode: 'development' as const, configDirectory: '/tmp/openfox-faithful' },
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

  const activeTaskCount = (): number => tasks.filter((t) => t.state === 'in_progress').length

  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    hostCalls.push({ method, url, body })

    // --- GitHub (fake) ---
    if (url.includes('api.github.com')) {
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
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }

    // --- The OpenFox host (faithful model) ---
    if (method === 'GET' && url.endsWith('/api/workflows')) {
      return new Response(
        JSON.stringify({
          defaults: [],
          userItems: (
            options.workflows ?? [
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
          ).map((w) => ({ id: w.id, parameters: w.parameters ?? [] })),
          projectItems: [],
        }),
        { status: 200 },
      )
    }

    if (method === 'PUT' && url.endsWith('/tasks/settings')) {
      slotLimit = Math.max(1, Math.min(10, Number((body as { slotLimit?: number })?.slotLimit ?? 1)))
      return new Response(JSON.stringify({ settings: { slotLimit } }), { status: 200 })
    }

    if (method === 'POST' && url.endsWith('/api/sessions')) {
      sessionCounter += 1
      sessions.push(`sess-${sessionCounter}`)
      return new Response(JSON.stringify({ session: { id: `sess-${sessionCounter}` } }), { status: 201 })
    }

    if (method === 'POST' && url.endsWith('/tasks')) {
      taskCounter += 1
      const prompt = (body as { prompt?: string })?.prompt ?? ''
      prompts.push(prompt)
      const task: HostTask = {
        id: `task-${taskCounter}`,
        prompt,
        state: 'todo',
        runState: 'idle',
      }
      tasks.push(task)
      return new Response(JSON.stringify({ task }), { status: 201 })
    }

    if (method === 'POST' && url.includes('/move')) {
      const id = url.split('/tasks/')[1]!.replace('/move', '')
      const task = tasks.find((t) => t.id === id)
      if (!task) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
      const to = (body as { to?: string })?.to
      if (to === 'done') {
        task.state = 'done'
        task.runState = 'idle'
        return new Response(JSON.stringify({ task }), { status: 200 })
      }
      if (to === 'in_progress') {
        task.state = 'in_progress'
        // THE FAITHFUL BEHAVIOUR: the host only reuses a session that has
        // NO MESSAGES. The plugin's own session already has the first
        // workflow's messages, so the host SEEDS A NEW SESSION and
        // reports it.
        const requested = (body as { sessionId?: string })?.sessionId
        const reusable =
          requested && sessions.filter((s) => s === requested).length > 0 && !usedSessions.has(requested)
        let sessionId = requested
        if (!reusable) {
          sessionCounter += 1
          sessionId = `sess-${sessionCounter}`
          sessions.push(sessionId)
        }
        if (sessionId) usedSessions.add(sessionId)
        task.sessionId = sessionId
        // THE SLOT: the host launches only when a slot is free.
        if (activeTaskCount() <= slotLimit) {
          task.runState = 'running'
        } else {
          task.runState = 'queued'
        }
        return new Response(
          JSON.stringify({
            task,
            sessionId: task.sessionId,
            runState: task.runState,
          }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ task }), { status: 200 })
    }

    if (method === 'DELETE' && url.includes('/tasks/')) {
      const id = url.split('/tasks/')[1]!
      const index = tasks.findIndex((t) => t.id === id)
      if (index >= 0) tasks.splice(index, 1)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }

    if (method === 'POST' && url.includes('/stop')) {
      return new Response(JSON.stringify({ success: true, queuedMessages: [] }), { status: 200 })
    }

    return new Response(JSON.stringify({ success: true }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchStub as unknown as typeof fetch)

  return {
    registry,
    calls,
    backing,
    tasks,
    activeTaskCount,
    sessions,
    prompts,
    hostCalls,
    context,
    logger,
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
