/**
 * openfox-automate — plugin entry point.
 *
 * Wires together: settings, UI panel + header action, RPC handlers, hooks,
 * LLM tools, scan timer. Runtime state lives in `context.storage` under
 * "queue", "history", "scan_state", "executions".
 */

import type { PluginContext, PluginRegistry } from 'openfox/plugin'
import {
  settingsSchema,
  parseRepoMapping,
  parseChain,
  parseRepoOverrides,
  parseIgnoreLabels,
} from './settings.js'
import { QueueStore, isTerminated, newEntryId } from './queue.js'
import { orderQueue, findMissingDependencies } from './ordering.js'
import { fetchAllOpenIssues, getIssue, listIssueComments, validateToken, isPullRequest } from './github.js'
import { spawnSessionFor } from './spawner.js'
import { startChain, buildIssueContext, buildIssueParams, processWorkflowEvent } from './chain.js'
import { createOrchestration, type OpenFoxOrchestration } from './orchestration.js'
import { getHostInternal } from './resolve-openfox.js'
import { postProcess, fetchAuthenticatedLogin } from './postprocess.js'
import { computeMetrics } from './metrics.js'
import type { HealthReport, PluginSettings, QueueEntry } from './types.js'
import { DEFAULT_SETTINGS } from './types.js'
import { RPC_NAMESPACE } from './constants.js'

interface Runtime {
  context: PluginContext
  settings: () => PluginSettings
  store: QueueStore
  timer: ReturnType<typeof setInterval> | null
  abortController: AbortController
  paused: boolean
  lastScanAt: string | null
  rateLimitedUntil: number | null
  executions: Map<string, { entryId: string; sessionId: string; chain: string[]; currentStep: number }>
  orchestration: OpenFoxOrchestration
  appliedExecutionEvents: Set<string>
}

let currentRt: Runtime | null = null

/**
 * Test-only lifecycle helpers. They are exported because the test suite
 * needs a deterministic reset between scenarios, but they MUST not be
 * available in the production plugin surface — gating them on
 * `process.env.NODE_ENV !== 'production'` removes them from the runtime
 * API exposed to a host that installs the package and from the bundled
 * `dist/index.d.ts` consumers rely on for typing.
 */
function isTestEnv(): boolean {
  return process.env['NODE_ENV'] !== 'production'
}

export function _resetLifecycleForTesting(): void {
  if (!isTestEnv()) return
  if (currentRt) {
    if (currentRt.timer) clearInterval(currentRt.timer)
    currentRt.timer = null
    currentRt.abortController.abort()
  }
  currentRt = null
}

export function _hasActiveRuntimeForTesting(): boolean {
  return isTestEnv() && currentRt !== null
}

function readSettingsFromContext(context: PluginContext): PluginSettings {
  const raw = (context.settings ? context.settings() : {}) as Record<string, unknown>
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS, ...raw }
  return merged as PluginSettings
}

function hasAnyPostToggle(settings: PluginSettings): boolean {
  return Boolean(
    settings['post.commentTemplate'] || settings['post.closeOnSuccess'] || settings['post.assignOnSuccess'],
  )
}

/**
 * Default chain, in STABLE WORKFLOW IDs.
 *
 * The host resolves a launch by `metadata.id` (`findWorkflowById` in
 * src/server/runner/orchestrator.ts), never by display name — a name like
 * "Plan Issue v2" cannot be resolved and the launch throws. The previous
 * default used display names, so the fallback chain was unlaunchable.
 *
 * V3: plan -> build+verify -> publish. There is deliberately no merge
 * workflow in the chain: `publish-pr-v1` stops at the PR, and the merge
 * policy (owner, mode, method) is read by OpenFox after publication.
 */
const DEFAULT_CHAIN = ['plan-issue-v3', 'build-verify-v3', 'publish-pr-v1']

function defaultChain(): string[] {
  return [...DEFAULT_CHAIN]
}

function resolveChain(entry: QueueEntry, settings: PluginSettings): string[] {
  const overrides = parseRepoOverrides(settings['workflows.repoOverrides'])
  const fromOverride = overrides.get(entry.repoKey)
  if (fromOverride && fromOverride.length > 0) return fromOverride
  return parseChain(settings['workflows.chain']).length > 0
    ? parseChain(settings['workflows.chain'])
    : defaultChain()
}

async function scanAll(rt: Runtime): Promise<{ added: number; skipped: number; errors: string[] }> {
  // If the plugin was deactivated mid-scan, the AbortController fires and
  // every in-flight fetch in github.ts will return error='aborted'. From
  // that point on we MUST NOT mutate host state (no notify, no storage,
  // no publish) — doing so would let a disabled plugin keep writing
  // through the host. We also guard the post-fetch state mutations with
  // a runtime-identity check so a stale async task that resumes after a
  // re-register() can also be told to exit cleanly.
  const settings = readSettingsFromContext(rt.context)
  const signal = rt.abortController.signal
  const isLive = (): boolean => !signal.aborted && currentRt === rt
  const token = settings['github.token']
  if (!token) {
    return { added: 0, skipped: 0, errors: ['missing github.token'] }
  }

  // L1 rate-limit backoff: if a previous scan hit the limit, wait until reset.
  if (rt.rateLimitedUntil && Date.now() < rt.rateLimitedUntil) {
    return {
      added: 0,
      skipped: 0,
      errors: [`rate-limited until ${new Date(rt.rateLimitedUntil).toISOString()}`],
    }
  }
  rt.rateLimitedUntil = null
  const repos = parseRepoMapping(settings['repos.mapping'])
  if (repos.length === 0) {
    return { added: 0, skipped: 0, errors: ['no repos mapped'] }
  }
  const ignoreLabels = parseIgnoreLabels(settings['scan.ignoreLabels'])
  const dryRun = Boolean(settings.dryRun)
  const errors: string[] = []
  const candidates: QueueEntry[] = []

  for (const { repoKey, projectId } of repos) {
    if (!isLive()) {
      errors.push(`aborted: scanAll stopped after deactivate (${repoKey} skipped)`)
      break
    }
    const [owner, repo] = repoKey.split('/', 2)
    if (!owner || !repo) {
      errors.push(`invalid repoKey ${repoKey}`)
      continue
    }
    const res = await fetchAllOpenIssues(token, owner, repo, { signal })
    if (!isLive()) {
      errors.push(`aborted: scanAll stopped after deactivate (${repoKey} skipped)`)
      break
    }
    if (res.error === 'aborted') {
      errors.push(`aborted: ${repoKey} fetch aborted`)
      break
    }
    if (!res.ok || !res.data) {
      errors.push(`${repoKey}: ${res.error ?? res.status}`)
      rt.context.notify({
        title: { en: 'Repo scan failed', fr: 'Échec du scan' },
        body: { en: `Could not scan ${repoKey}`, fr: `Impossible de scanner ${repoKey}` },
        level: 'error',
      })
      continue
    }
    if (res.rateLimit.remaining < 100) {
      rt.context.notify({
        title: { en: 'GitHub rate limit low', fr: 'Rate-limit GitHub bas' },
        body: { en: `${res.rateLimit.remaining} remaining`, fr: `${res.rateLimit.remaining} restant(s)` },
        level: 'warning',
      })
    }
    for (const issue of res.data) {
      if (isPullRequest(issue)) continue
      const labels = issue.labels.map((l) => (typeof l === 'string' ? l : l.name))
      if (ignoreLabels.length > 0 && labels.some((l) => ignoreLabels.includes(l.toLowerCase()))) continue
      candidates.push({
        id: newEntryId(),
        repoKey,
        projectId,
        issueNumber: issue.number,
        title: issue.title,
        body: issue.body ?? '',
        url: issue.html_url,
        labels,
        comments: [],
        dependsOn: [],
        status: 'queued',
        position: 0,
        addedAt: new Date().toISOString(),
      })
    }
  }

  // Final deactivate-guard: aborts can land between the per-repo loop
  // and the post-fetch bookkeeping below. Don't write anything back to
  // the host if we've been torn down.
  if (!isLive()) {
    errors.push('aborted: scanAll stopped before storing results')
    return { added: 0, skipped: 0, errors }
  }

  const { added, skipped } = await rt.store.addNew(candidates)
  const ordered = await orderAndStore(rt)
  rt.lastScanAt = new Date().toISOString()
  publishQueue(rt, ordered)
  if (added.length > 0 && !dryRun) {
    rt.context.notify({
      title: {
        en: `${added.length} new issue(s) in queue`,
        fr: `${added.length} nouvelle(s) issue(s) dans la file`,
      },
      level: 'info',
    })
  }
  return { added: added.length, skipped, errors }
}

async function orderAndStore(rt: Runtime): Promise<QueueEntry[]> {
  const settings = readSettingsFromContext(rt.context)
  const active = await rt.store.loadActive()
  const { ordered, cycleEntries } = orderQueue(
    active,
    settings['ordering.strategy'] ?? 'default',
    settings['ordering.dependencyPattern'] ?? '(#(\\d+))',
  )
  const blockedByMissing = findMissingDependencies(ordered).map((x) => x.entry)
  const blockedIds = new Set([...cycleEntries.map((e) => e.id), ...blockedByMissing.map((e) => e.id)])
  const final = ordered.map((e) =>
    blockedIds.has(e.id) ? { ...e, status: 'blocked' as const, error: 'missing or circular dependency' } : e,
  )
  await rt.store.replace(final)
  await rt.store.pruneHistory(settings['history.retentionCount'] ?? 100)
  return final
}

function publishQueue(rt: Runtime, active: QueueEntry[]): void {
  rt.context.publish('issue-queue-panel', 'queue', active)
  rt.context.publish('issue-queue-panel', 'autoScan', {
    enabled: !rt.paused && rt.timer != null,
    lastScanAt: rt.lastScanAt,
    nextScanAt: rt.paused || !rt.timer ? null : nextScanAtIso(rt),
    intervalMinutes: readSettingsFromContext(rt.context)['scan.refreshMinutes'] ?? 30,
  })
  const settings = readSettingsFromContext(rt.context)
  rt.context.publish('issue-queue-panel', 'state', { dryRun: Boolean(settings.dryRun) })
}

function nextScanAtIso(rt: Runtime): string | null {
  if (!rt.timer) return null
  const settings = readSettingsFromContext(rt.context)
  const minutes = settings['scan.refreshMinutes'] ?? 30
  return new Date(Date.now() + minutes * 60_000).toISOString()
}

async function pickAndSpawnNext(rt: Runtime): Promise<QueueEntry | null> {
  const settings = readSettingsFromContext(rt.context)
  const maxGlobal = settings['batch.maxConcurrency'] ?? 3
  const maxPerRepo = settings['batch.maxConcurrencyPerRepo'] ?? 2
  const dryRun = Boolean(settings.dryRun)

  const active = await rt.store.loadActive()
  const runningCount = active.filter((e) => e.status === 'running').length
  if (runningCount >= maxGlobal) return null
  const runningByRepo = new Map<string, number>()
  for (const e of active) {
    if (e.status === 'running') runningByRepo.set(e.repoKey, (runningByRepo.get(e.repoKey) ?? 0) + 1)
  }

  for (const entry of active) {
    if (entry.status !== 'queued') continue
    if (dryRun) {
      rt.context.logger.info(`[DRY RUN] would spawn session for ${entry.repoKey}#${entry.issueNumber}`)
      return entry
    }
    const perRepoCount = runningByRepo.get(entry.repoKey) ?? 0
    if (perRepoCount >= maxPerRepo) continue
    return await spawnEntry(rt, entry)
  }
  return null
}

async function spawnEntry(rt: Runtime, entry: QueueEntry): Promise<QueueEntry> {
  const settings = readSettingsFromContext(rt.context)
  const chain = resolveChain(entry, settings)
  const updated: QueueEntry = {
    ...entry,
    status: 'running',
    startedAt: new Date().toISOString(),
    executionStack: chain.map((id) => ({
      workflowId: id,
      workflowName: id,
      status: 'pending' as const,
      retryCount: 0,
    })),
  }
  await rt.store.update(updated)

  try {
    const session = await spawnSessionFor(updated, { context: rt.context })
    if (session.id) updated.sessionId = session.id
    if (chain.length > 0) {
      // startChain returns a stack with the first workflow marked running —
      // assign it back so subsequent reads (RPC, hooks, store) see the
      // running status immediately, before the workflow fires its first
      // workflow.execution.changed event.
      updated.executionStack = startChain(updated, createLaunchDriver(rt), {
        sessionId: updated.sessionId ?? '',
      })
    }
    await rt.store.update(updated)
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e)
    updated.status = 'failed'
    updated.error = err
    updated.finishedAt = new Date().toISOString()
    await rt.store.update(updated)
    rt.context.notify({
      title: { en: 'Spawn failed', fr: 'Échec du spawn' },
      body: { en: err, fr: err },
      level: 'error',
    })
  }
  return updated
}

function createLaunchDriver(rt: Runtime): {
  launch(params: {
    sessionId: string
    workflowId: string
    content: string
    params: Record<string, string>
  }): void
} {
  return {
    launch: (p) => {
      try {
        rt.orchestration.launchWorkflow({
          sessionId: p.sessionId,
          workflowId: p.workflowId,
          params: p.params,
          content: p.content,
        })
      } catch (err) {
        rt.context.logger.error(`launchWorkflow failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  }
}

async function healthCheck(rt: Runtime, context: PluginContext): Promise<HealthReport> {
  const settings = readSettingsFromContext(context)
  const token = settings['github.token'] ?? ''
  const signal = rt.abortController.signal
  const tokenRes = token
    ? await validateToken(token, signal)
    : { valid: false, rateLimit: { remaining: 0, resetAt: null } }
  const repos = parseRepoMapping(settings['repos.mapping'])
  const reposAccessible: Record<string, 'ok' | '404' | '403' | 'unknown'> = {}
  for (const { repoKey } of repos) {
    const [owner, repo] = repoKey.split('/', 2)
    if (!owner || !repo || !token) {
      reposAccessible[repoKey] = 'unknown'
      continue
    }
    const res = await getIssue(token, owner, repo, 1, signal)
    if (res.status === 404) reposAccessible[repoKey] = '404'
    else if (res.status === 403) reposAccessible[repoKey] = '403'
    else if (res.ok) reposAccessible[repoKey] = 'ok'
    else reposAccessible[repoKey] = 'unknown'
  }
  const workflows: Record<string, 'ok' | 'not-found'> = {}
  for (const wf of parseChain(settings['workflows.chain'])) {
    workflows[wf] = 'ok'
  }
  const projects: Record<string, 'ok' | 'missing'> = {}
  for (const { repoKey, projectId } of repos) {
    projects[`${repoKey}→${projectId}`] = projectId ? 'ok' : 'missing'
  }
  const mappingIssues: string[] = []
  for (const line of (settings['repos.mapping'] ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    if (!trimmed.includes('=') || !trimmed.split('=')[0]?.includes('/')) {
      mappingIssues.push(`malformed line: ${trimmed}`)
    }
  }
  const internal = await getHostInternal(context)
  const hasFacade = internal?.kind === 'facade'
  const hasLegacy = internal?.kind === 'legacy'
  return {
    github: { tokenValid: tokenRes.valid, rateLimitRemaining: tokenRes.rateLimit.remaining, reposAccessible },
    openFoxInternals: {
      sessionManager: internal ? 'ok' : 'missing',
      launchWorkflowRun: hasLegacy ? 'ok' : hasFacade ? 'ok' : 'missing',
      host: hasFacade ? 'ok' : 'missing',
    },
    workflows,
    projects,
    mapping: { valid: mappingIssues.length === 0, issues: mappingIssues },
  }
}

export function register(registry: PluginRegistry): void {
  const context = registry.context
  // If a previous runtime is still registered (host hot-reload, caller
  // forgot to deactivate, …) tear it down so its timer and in-flight
  // fetches don't outlive the new runtime. Without this, overwriting
  // currentRt below would orphan the previous setInterval handle and
  // its AbortController, leaking timers forever.
  if (currentRt !== null) {
    if (currentRt.timer) {
      clearInterval(currentRt.timer)
      currentRt.timer = null
    }
    currentRt.abortController.abort()
    currentRt.executions.clear()
    currentRt.appliedExecutionEvents.clear()
  }
  const store = new QueueStore({
    get: async (k: string) => (await context.storage?.get(k)) as unknown,
    set: async (k: string, v: unknown) => {
      await context.storage?.set(k, v as Parameters<NonNullable<typeof context.storage.set>>[1])
    },
  })

  const settingsReader = () => readSettingsFromContext(context)
  const rt: Runtime = {
    context,
    settings: settingsReader,
    store,
    timer: null,
    abortController: new AbortController(),
    paused: false,
    lastScanAt: null,
    rateLimitedUntil: null,
    executions: new Map(),
    orchestration: createOrchestration(context),
    appliedExecutionEvents: new Set(),
  }
  currentRt = rt

  registry.registerSettings(settingsSchema)

  registry.registerUiAction({
    id: 'open-issue-queue',
    slot: 'header.actions',
    label: { en: 'Issue Queue', fr: 'Issue Queue' },
    icon: 'puzzle',
    onActivate: { kind: 'openPanel', panelId: 'issue-queue-panel' },
  })

  registry.registerUiPanel({
    id: 'issue-queue-panel',
    title: { en: 'Issue Queue', fr: 'File d’attente d’issues' },
    size: 'xl',
    kind: 'iframe',
    url: 'dist/panel.html',
  })

  registry.registerAsset('dist/panel.html')

  registry.registerRpc(`${RPC_NAMESPACE}ping`, async () => ({
    ok: true,
    plugin: context.id,
    version: context.version,
    timestamp: new Date().toISOString(),
  }))

  registry.registerRpc(`${RPC_NAMESPACE}scanNow`, async () => scanAll(rt))

  registry.registerRpc(`${RPC_NAMESPACE}health`, async () => healthCheck(rt, context))

  registry.registerRpc(`${RPC_NAMESPACE}getQueue`, async (params: unknown) => {
    const p = (params ?? {}) as { filter?: string; statusFilter?: string[] }
    const active = await rt.store.loadActive()
    const text = p.filter?.toLowerCase() ?? ''
    const statuses = new Set(p.statusFilter ?? [])
    return active
      .filter((e) => statuses.size === 0 || statuses.has(e.status))
      .filter((e) => !text || `${e.title} ${e.body} ${e.url}`.toLowerCase().includes(text))
  })

  registry.registerRpc(`${RPC_NAMESPACE}getHistory`, async (params: unknown) => {
    const p = (params ?? {}) as { limit?: number; offset?: number }
    const history = await rt.store.loadHistory()
    const limit = p.limit ?? 100
    const offset = p.offset ?? 0
    return history.slice(offset, offset + limit)
  })

  registry.registerRpc(`${RPC_NAMESPACE}getMetrics`, async () => {
    const history = await rt.store.loadHistory()
    return computeMetrics(history)
  })

  registry.registerRpc(`${RPC_NAMESPACE}startIssue`, async (params: unknown) => {
    const { queueId } = (params ?? {}) as { queueId: string }
    const entry = await rt.store.findById(queueId)
    if (!entry) throw new Error(`queue entry not found: ${queueId}`)
    if (entry.status !== 'queued') throw new Error(`cannot start entry in status ${entry.status}`)
    return await spawnEntry(rt, entry)
  })

  registry.registerRpc(`${RPC_NAMESPACE}cancelIssue`, async (params: unknown) => {
    const { queueId } = (params ?? {}) as { queueId: string }
    const entry = await rt.store.findById(queueId)
    if (!entry) throw new Error(`queue entry not found: ${queueId}`)
    if (entry.sessionId) {
      try {
        await rt.orchestration.stopSession(entry.sessionId)
      } catch (err) {
        context.logger.warn(
          `automate.cancelIssue: stopSession failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    return await rt.store.transitionTo(queueId, 'cancelled', { finishedAt: new Date().toISOString() })
  })

  registry.registerRpc(`${RPC_NAMESPACE}removeIssue`, async (params: unknown) => {
    const { queueId } = (params ?? {}) as { queueId: string }
    await rt.store.remove(queueId)
    return { ok: true }
  })

  registry.registerRpc(`${RPC_NAMESPACE}reprocess`, async (params: unknown) => {
    const { queueId } = (params ?? {}) as { queueId: string }
    const settings = readSettingsFromContext(context)
    const entry = await rt.store.findById(queueId)
    if (!entry) throw new Error(`queue entry not found: ${queueId}`)
    if (!isTerminated(entry.status) && entry.status !== 'blocked') {
      throw new Error(`cannot reprocess entry in status ${entry.status}`)
    }
    const reset = settings['post.reprocessResetsRetryCount']
    const executionStack = entry.executionStack?.map((s) =>
      reset ? { ...s, retryCount: 0, status: 'pending' as const } : s,
    )
    const updated: QueueEntry = {
      ...entry,
      status: 'queued',
      ...(executionStack ? { executionStack } : {}),
    }
    delete updated.startedAt
    delete updated.finishedAt
    delete updated.error
    await rt.store.update(updated)
    await pickAndSpawnNext(rt)
    return updated
  })

  registry.registerRpc(`${RPC_NAMESPACE}addIssueByUrl`, async (params: unknown) => {
    const { url } = (params ?? {}) as { url: string }
    const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/)
    if (!m) throw new Error(`invalid GitHub issue URL: ${url}`)
    const [, owner, repo, num] = m
    if (!owner || !repo || !num) throw new Error(`invalid GitHub issue URL: ${url}`)
    const settings = readSettingsFromContext(context)
    const token = settings['github.token'] ?? ''
    const signal = rt.abortController.signal
    const res = await getIssue(token, owner, repo, Number(num), signal)
    if (!res.ok || !res.data) throw new Error(`could not fetch ${url}: ${res.error ?? res.status}`)
    const repos = parseRepoMapping(settings['repos.mapping'])
    const mapping = repos.find((r) => r.repoKey === `${owner}/${repo}`)
    if (!mapping) throw new Error(`no project mapping for ${owner}/${repo}`)
    const commentsRes = await listIssueComments(token, owner, repo, Number(num), signal)
    const comments = (commentsRes.data ?? []).map((c) => ({
      author: c.user?.login ?? 'unknown',
      body: c.body,
      createdAt: c.created_at,
    }))
    const labels = res.data.labels.map((l) => (typeof l === 'string' ? l : l.name))
    const entry: QueueEntry = {
      id: newEntryId(),
      repoKey: `${owner}/${repo}`,
      projectId: mapping.projectId,
      issueNumber: res.data.number,
      title: res.data.title,
      body: res.data.body ?? '',
      url: res.data.html_url,
      labels,
      comments,
      dependsOn: [],
      status: 'queued',
      position: 0,
      addedAt: new Date().toISOString(),
    }
    const { added } = await rt.store.addNew([entry])
    await orderAndStore(rt)
    return added[0] ?? entry
  })

  registry.registerRpc(`${RPC_NAMESPACE}addIssueRaw`, async (params: unknown) => {
    const p = (params ?? {}) as { repoKey: string; title: string; body: string; labels?: string[] }
    const settings = readSettingsFromContext(context)
    const repos = parseRepoMapping(settings['repos.mapping'])
    const mapping = repos.find((r) => r.repoKey === p.repoKey)
    if (!mapping) throw new Error(`no project mapping for ${p.repoKey}`)
    const entry: QueueEntry = {
      id: newEntryId(),
      repoKey: p.repoKey,
      projectId: mapping.projectId,
      issueNumber: Date.now(),
      title: p.title,
      body: p.body,
      url: '',
      labels: p.labels ?? [],
      comments: [],
      dependsOn: [],
      status: 'queued',
      position: 0,
      addedAt: new Date().toISOString(),
    }
    const { added } = await rt.store.addNew([entry])
    await orderAndStore(rt)
    return added[0] ?? entry
  })

  registry.registerRpc(`${RPC_NAMESPACE}pauseAutoScan`, async () => {
    rt.paused = true
    publishQueue(rt, await rt.store.loadActive())
    return { paused: true }
  })

  registry.registerRpc(`${RPC_NAMESPACE}resumeAutoScan`, async () => {
    rt.paused = false
    publishQueue(rt, await rt.store.loadActive())
    return { paused: false }
  })

  function safeHook<F extends (...args: unknown[]) => Promise<void>>(name: string, fn: F): F {
    return (async (...args: unknown[]) => {
      try {
        await fn(...args)
      } catch (err) {
        context.logger.error(`hook ${name} failed`, {
          message: err instanceof Error ? err.message : String(err),
        })
      }
    }) as F
  }

  registry.registerHook(
    'tool.completed',
    safeHook('tool.completed', async (payload: unknown) => {
      const p = payload as { sessionId?: string; output?: string }
      if (!p.sessionId || !p.output) return
      const settings = readSettingsFromContext(context)
      const re = new RegExp(settings['pr.urlRegex'] ?? 'https://github\\.com/[^/]+/[^/]+/pull/(\\d+)', 'i')
      const match = re.exec(p.output)
      if (!match) return
      const active = await rt.store.loadActive()
      const entry = active.find((e) => e.sessionId === p.sessionId)
      if (!entry || entry.prUrl) return
      entry.prUrl = match[0]
      await rt.store.update(entry)
      publishQueue(rt, await rt.store.loadActive())
    }),
  )

  registry.registerHook(
    'workflow.execution.changed',
    safeHook('workflow.execution.changed', async (payload: unknown) => {
      const p = payload as {
        sessionId?: string
        workflowId?: string
        status?: string
        executionId?: string
        currentStepId?: string
      }
      const active = await rt.store.loadActive()
      const entry = active.find((e) => e.sessionId === p.sessionId)
      if (!entry) return

      const outcome = processWorkflowEvent(
        entry,
        {
          sessionId: p.sessionId,
          workflowId: p.workflowId,
          executionId: p.executionId,
          status: p.status as 'pending' | 'running' | 'done' | 'blocked' | undefined,
        },
        {
          appliedExecutionEvents: rt.appliedExecutionEvents,
          log: (msg) => context.logger.warn(msg),
          buildIssueContext,
          buildIssueParams,
        },
      )

      if (outcome.deduplicated) return

      for (const launch of outcome.launches) {
        rt.orchestration.launchWorkflow({
          sessionId: launch.sessionId,
          workflowId: launch.workflowId,
          params: launch.params,
          content: launch.content,
        })
      }

      if (outcome.transitionTo === 'done') {
        await rt.store.transitionTo(entry.id, 'done', {
          executionStack: entry.executionStack ?? [],
          finishedAt: new Date().toISOString(),
        })
        await maybePostProcess(rt, entry)
        await pickAndSpawnNext(rt)
      } else if (outcome.transitionTo === 'blocked') {
        await rt.store.transitionTo(entry.id, 'blocked', {
          executionStack: entry.executionStack ?? [],
          error: outcome.blockedReason ?? `workflow ${p.workflowId} blocked`,
        })
        context.notify({
          title: { en: 'Workflow blocked', fr: 'Workflow bloqué' },
          body: {
            en: `Issue #${entry.issueNumber} needs intervention`,
            fr: `Issue #${entry.issueNumber} demande intervention`,
          },
          level: 'error',
        })
      } else if (outcome.launches.length === 0) {
        await rt.store.update({
          ...entry,
          ...(entry.executionStack ? { executionStack: entry.executionStack } : {}),
        })
      }

      publishQueue(rt, await rt.store.loadActive())
    }),
  )

  registry.registerHook(
    'task.completed',
    safeHook('task.completed', async () => {
      await pickAndSpawnNext(rt)
      publishQueue(rt, await rt.store.loadActive())
    }),
  )

  registry.registerTool({
    name: 'issue_queue_list',
    description:
      'Returns the current active issue queue with status, position, repo, and current workflow step.',
    parameters: {
      type: 'object',
      properties: { statusFilter: { type: 'array', items: { type: 'string' } } },
    },
    execute: async (args) => {
      const p = (args ?? {}) as { statusFilter?: string[] }
      const active = await rt.store.loadActive()
      const statuses = new Set(p.statusFilter ?? [])
      const filtered = statuses.size === 0 ? active : active.filter((e) => statuses.has(e.status))
      return {
        success: true,
        output: JSON.stringify(
          filtered.map((e) => ({
            id: e.id,
            issueNumber: e.issueNumber,
            title: e.title,
            status: e.status,
            position: e.position,
            repoKey: e.repoKey,
          })),
        ),
      }
    },
  })

  registry.registerTool({
    name: 'issue_queue_status',
    description: 'Returns the detailed status of one queue entry by id.',
    parameters: { type: 'object', properties: { queueId: { type: 'string' } }, required: ['queueId'] },
    execute: async (args) => {
      const p = (args ?? {}) as { queueId: string }
      const entry = await rt.store.findById(p.queueId)
      if (!entry) return { success: false, error: `queue entry not found: ${p.queueId}` }
      return { success: true, output: JSON.stringify(entry) }
    },
  })

  async function maybePostProcess(rt: Runtime, entry: QueueEntry): Promise<void> {
    const settings = readSettingsFromContext(rt.context)
    if (!hasAnyPostToggle(settings)) return
    const token = settings['github.token']
    if (!token) return
    const [owner, repo] = entry.repoKey.split('/', 2)
    if (!owner || !repo) return
    if (rt.abortController.signal.aborted) return
    const signal = rt.abortController.signal
    const me = settings['post.assignOnSuccess'] ? await fetchAuthenticatedLogin(token, signal) : undefined
    if (rt.abortController.signal.aborted) return
    await postProcess(
      entry,
      settings,
      {
        summary: `OpenFox chain completed for #${entry.issueNumber}`,
        sessionUrl: '',
        prUrl: entry.prUrl ?? '',
        ...(me ? { me } : {}),
      },
      { token, owner, repo, signal: rt.abortController.signal },
    )
  }

  async function startTimer() {
    const settings = readSettingsFromContext(context)
    const minutes = settings['scan.refreshMinutes'] ?? 30
    if (rt.timer) clearInterval(rt.timer)
    rt.timer = setInterval(() => {
      if (rt.paused) return
      void scanAll(rt).then(() => monitorAndPublish())
    }, minutes * 60_000)
  }

  async function monitorAndPublish() {
    const settings = readSettingsFromContext(context)
    if (!settings['pr.monitorEnabled']) return
    const token = settings['github.token']
    if (!token) return
    if (rt.abortController.signal.aborted) return
    const { monitorPRs } = await import('./pr-monitor.js')
    const result = await monitorPRs({
      token,
      store: rt.store,
      notify: (n) => context.notify(n),
      republish: () => {
        void rt.store.loadActive().then((q) => publishQueue(rt, q))
      },
      signal: rt.abortController.signal,
    })
    if (result.checked > 0 || result.errors.length > 0) {
      context.logger.info(
        `pr-monitor: checked=${result.checked} completed=${result.completed} failed=${result.failed} errors=${result.errors.length}`,
      )
    }
  }

  void startTimer()
  if (readSettingsFromContext(context)['scan.startupScan']) {
    void scanAll(rt).then(() => monitorAndPublish())
  }
  void orderAndStore(rt)
  void publishQueue(rt, [])
  context.logger.info('openfox-automate registered')
}

export function deactivate(): void {
  // The host expects a clean lifecycle on disable / uninstall: stop the
  // periodic scan timer and cancel any in-flight fetches started under
  // the active AbortController. We keep a module-level reference to the
  // current runtime so this cleanup can actually reach the handles that
  // register() put in place.
  const rt = currentRt
  currentRt = null
  if (!rt) return
  if (rt.timer) {
    clearInterval(rt.timer)
    rt.timer = null
  }
  // AbortController.abort() is idempotent: a second call is a no-op and
  // does not throw, so no try/catch is needed.
  rt.abortController.abort()
  // Drop the dedup set and executions map so a future enable starts fresh
  // even if the host re-uses the module instance.
  rt.executions.clear()
  rt.appliedExecutionEvents.clear()
}

export default { register, deactivate }
