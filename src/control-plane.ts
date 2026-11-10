/**
 * Durable control plane for the issue queue.
 *
 * The plugin owns a small, deterministic scheduler. It is deliberately
 * SEPARATE from the chain engine (`src/chain.ts`): the engine advances
 * one session's workflow chain, the control plane decides WHICH issues run
 * and reserves the worker slots.
 *
 * Why a control plane is needed
 *
 * The OpenFox host has a task board with its own slots, gates and links
 * (`/api/projects/:id/tasks`), but a plugin cannot reach it: it is not
 * part of `PluginContext`, and its service is internal to the server
 * (`setTasksService`). Driving the host's task board from a plugin would
 * require either an upstream API change or the fragile internal import
 * this plugin must not do. So the plugin keeps its OWN durable registry,
 * with the same discipline: exclusive reservation, explicit capacity,
 * idempotent recovery.
 *
 * Guarantees
 *
 *   - EXCLUSIVE RESERVATION. A worker slot is reserved with a lease; a
 *     second scheduler cannot reserve the same issue.
 *   - BOUNDED CAPACITY. At most `maxWorkers` (5 by default) issues run at
 *     once, globally and per repository.
 *   - DURABLE. The whole registry lives in ONE storage key, so the host's
 *     JSON round-trip makes it atomic per write: there is no read-modify-
 *     write across several keys.
 *   - IDEMPOTENT RECOVERY. Every reservation carries a lease; expired
 *     leases are reclaimed on load, so a crashed host does not leak
 *     slots.
 *   - NO LLM. Admission, ordering, reservation and budget accounting are
 *     pure functions over the registry.
 */

export type WorkItemStatus = 'queued' | 'reserved' | 'running' | 'done' | 'failed' | 'blocked' | 'cancelled'

export interface WorkItem {
  /** Stable identity: `<repoKey>#<issueNumber>`. */
  key: string
  repoKey: string
  projectId: string
  issueNumber: number
  title: string
  url: string
  status: WorkItemStatus
  /** Position in the admission order (lower = earlier). */
  priority: number
  /** Issue numbers this item depends on. */
  dependsOn: number[]
  /** Session currently handling the item, when reserved/running. */
  sessionId?: string | undefined
  /** Epoch ms after which the reservation is considered stale. */
  leaseExpiresAt?: number | undefined
  /** Number of attempts so far. */
  attempt: number
  /** Cumulative token usage attributed to this item. */
  tokens: TokenUsage
  /** Free-form failure reason. */
  error?: string | undefined
  updatedAt: string
}

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedPromptTokens: number
  cacheWriteTokens: number
  llmCalls: number
}

export const EMPTY_TOKEN_USAGE: TokenUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cachedPromptTokens: 0,
  cacheWriteTokens: 0,
  llmCalls: 0,
}

export interface ControlPlaneState {
  version: number
  items: Record<string, WorkItem>
  /** Monotonic counter used to build stable priorities. */
  sequence: number
  updatedAt: string
}

export function emptyControlPlaneState(): ControlPlaneState {
  return { version: 1, items: {}, sequence: 0, updatedAt: new Date(0).toISOString() }
}

export interface ControlPlaneOptions {
  /** Maximum simultaneous workers, globally. */
  maxWorkers: number
  /** Maximum simultaneous workers per repository. */
  maxWorkersPerRepo: number
  /** Lease duration in ms. */
  leaseMs: number
  /** Maximum total tokens per issue before it is blocked. 0 = unlimited. */
  maxTokensPerIssue: number
}

export const DEFAULT_CONTROL_PLANE_OPTIONS: ControlPlaneOptions = {
  maxWorkers: 5,
  maxWorkersPerRepo: 2,
  leaseMs: 10 * 60_000,
  maxTokensPerIssue: 0,
}

export interface AdmissionCandidate {
  repoKey: string
  projectId: string
  issueNumber: number
  title: string
  url: string
  dependsOn?: number[]
  labels?: string[]
}

export interface AdmissionResult {
  admitted: WorkItem[]
  /** Candidates already known (same repoKey#issueNumber). */
  duplicates: number
}

/**
 * Classify an issue the way the admission rules do.
 *
 * `bug` issues come first, then features, then docs, then everything else.
 * Within a class, the insertion order decides (FIFO).
 */
export function classifyLabels(labels: string[]): 'bug' | 'feature' | 'docs' | 'other' {
  const text = labels.join(' ').toLowerCase()
  if (/\b(bug|fix|defect)\b/.test(text)) return 'bug'
  if (/\b(feature|enhancement|improvement)\b/.test(text)) return 'feature'
  if (/\b(doc|documentation)\b/.test(text)) return 'docs'
  return 'other'
}

const CLASS_RANK: Record<'bug' | 'feature' | 'docs' | 'other', number> = {
  bug: 0,
  feature: 1,
  docs: 2,
  other: 3,
}

/**
 * Build the priority of a candidate.
 *
 * The priority is a NUMBER so the queue can be sorted deterministically:
 * lower sorts first. It encodes the class rank and the admission order.
 *
 * The class rank is multiplied by a LARGE base so that the admission
 * sequence (which grows by 1 per item) can never overflow into the class
 * range. The base must stay well above the maximum plausible sequence.
 */
export function computePriority(labels: string[], sequence: number): number {
  return CLASS_RANK[classifyLabels(labels)] * 1_000_000_000 + sequence
}

/**
 * Admit candidates into the registry.
 *
 * Idempotent: an item already present is never re-admitted, and the
 * priority of an existing item is never rewritten (so a running item is
 * not re-prioritised under it).
 */
export function admit(
  state: ControlPlaneState,
  candidates: AdmissionCandidate[],
  options: { now?: number } = {},
): AdmissionResult {
  const now = options.now ?? Date.now()
  const admitted: WorkItem[] = []
  let duplicates = 0

  for (const candidate of candidates) {
    const key = `${candidate.repoKey}#${candidate.issueNumber}`
    if (state.items[key]) {
      duplicates += 1
      continue
    }
    state.sequence += 1
    const item: WorkItem = {
      key,
      repoKey: candidate.repoKey,
      projectId: candidate.projectId,
      issueNumber: candidate.issueNumber,
      title: candidate.title,
      url: candidate.url,
      status: 'queued',
      priority: computePriority(candidate.labels ?? [], state.sequence),
      dependsOn: candidate.dependsOn ?? [],
      attempt: 0,
      tokens: { ...EMPTY_TOKEN_USAGE },
      updatedAt: new Date(now).toISOString(),
    }
    state.items[key] = item
    admitted.push(item)
  }

  state.updatedAt = new Date(now).toISOString()
  return { admitted, duplicates }
}

/**
 * Reclaim expired leases.
 *
 * A reservation whose lease expired (the host crashed, the session died)
 * is BLOCKED, not silently re-queued.
 *
 * The distinction matters: the host session may STILL be running (the
 * plugin lost track of it, but the host did not). Re-queueing the issue
 * would let a second session start for the same issue while the first one
 * is still working on it — a duplicate run, two agents editing the same
 * code. Blocking keeps the issue visible and requires an operator to
 * confirm the host session is really gone before it runs again.
 */
export function reclaimExpiredLeases(state: ControlPlaneState, options: { now?: number } = {}): WorkItem[] {
  const now = options.now ?? Date.now()
  const reclaimed: WorkItem[] = []
  for (const item of Object.values(state.items)) {
    if (item.status === 'reserved' || item.status === 'running') {
      if (item.leaseExpiresAt !== undefined && item.leaseExpiresAt <= now) {
        item.status = 'blocked'
        item.leaseExpiresAt = undefined
        item.error =
          'lease expired — the host session may still be running; ' +
          'confirm it is gone before reprocessing (prevents a duplicate session)'
        item.updatedAt = new Date(now).toISOString()
        reclaimed.push(item)
      }
    }
  }
  if (reclaimed.length > 0) state.updatedAt = new Date(now).toISOString()
  return reclaimed
}

/**
 * An item can run only when every dependency is DONE.
 *
 * A dependency that is unknown (never admitted) leaves the item BLOCKED:
 * the plugin must not start work whose prerequisite is missing.
 */
export function dependencyState(
  state: ControlPlaneState,
  item: WorkItem,
): { satisfied: boolean; missing: number[]; blocked: number[] } {
  const missing: number[] = []
  const blocked: number[] = []
  for (const dep of item.dependsOn) {
    const depItem = Object.values(state.items).find(
      (i) => i.repoKey === item.repoKey && i.issueNumber === dep,
    )
    if (!depItem) {
      missing.push(dep)
    } else if (depItem.status !== 'done') {
      blocked.push(dep)
    }
  }
  return { satisfied: missing.length === 0 && blocked.length === 0, missing, blocked }
}

export interface ReservationResult {
  reserved: WorkItem[]
  /** Items that could not be reserved, with the reason. */
  skipped: Array<{ key: string; reason: string }>
}

/**
 * Reserve worker slots.
 *
 * The scheduler is deterministic: items are considered in priority order,
 * and the FIRST item that can be reserved takes the first free slot. The
 * capacity limits are global and per repository.
 */
export function reserve(
  state: ControlPlaneState,
  options: ControlPlaneOptions & { now?: number },
): ReservationResult {
  const now = options.now ?? Date.now()
  reclaimExpiredLeases(state, { now })

  const running = Object.values(state.items).filter((i) => i.status === 'running' || i.status === 'reserved')
  const runningByRepo = new Map<string, number>()
  for (const item of running) {
    runningByRepo.set(item.repoKey, (runningByRepo.get(item.repoKey) ?? 0) + 1)
  }

  const queued = Object.values(state.items)
    .filter((i) => i.status === 'queued')
    .sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key))

  const reserved: WorkItem[] = []
  const skipped: ReservationResult['skipped'] = []

  for (const item of queued) {
    const activeCount = running.length + reserved.length
    if (activeCount >= options.maxWorkers) {
      skipped.push({ key: item.key, reason: 'global worker limit reached' })
      continue
    }
    const repoCount =
      (runningByRepo.get(item.repoKey) ?? 0) + reserved.filter((r) => r.repoKey === item.repoKey).length
    if (repoCount >= options.maxWorkersPerRepo) {
      skipped.push({ key: item.key, reason: 'per-repository worker limit reached' })
      continue
    }
    const deps = dependencyState(state, item)
    if (!deps.satisfied) {
      if (deps.missing.length > 0) {
        item.status = 'blocked'
        item.error = `missing dependency: ${deps.missing.join(', ')}`
        item.updatedAt = new Date(now).toISOString()
        skipped.push({ key: item.key, reason: `missing dependency: ${deps.missing.join(', ')}` })
      } else {
        skipped.push({ key: item.key, reason: `waiting for dependency: ${deps.blocked.join(', ')}` })
      }
      continue
    }
    if (options.maxTokensPerIssue > 0 && item.tokens.totalTokens >= options.maxTokensPerIssue) {
      item.status = 'blocked'
      item.error = `token budget exceeded (${item.tokens.totalTokens}/${options.maxTokensPerIssue})`
      item.updatedAt = new Date(now).toISOString()
      skipped.push({ key: item.key, reason: 'token budget exceeded' })
      continue
    }

    item.status = 'reserved'
    item.attempt += 1
    item.leaseExpiresAt = now + options.leaseMs
    item.updatedAt = new Date(now).toISOString()
    reserved.push(item)
  }

  state.updatedAt = new Date(now).toISOString()
  return { reserved, skipped }
}

/** Attach a session to a reserved item and mark it running. */
export function markRunning(
  state: ControlPlaneState,
  key: string,
  sessionId: string,
  options: { now?: number } = {},
): WorkItem | null {
  const item = state.items[key]
  if (!item) return null
  const now = options.now ?? Date.now()
  item.status = 'running'
  item.sessionId = sessionId
  item.updatedAt = new Date(now).toISOString()
  state.updatedAt = item.updatedAt
  return item
}

/** Mark an item as finished (or failed / cancelled). */
export function completeItem(
  state: ControlPlaneState,
  key: string,
  status: 'done' | 'failed' | 'cancelled' | 'blocked',
  options: { now?: number; error?: string } = {},
): WorkItem | null {
  const item = state.items[key]
  if (!item) return null
  const now = options.now ?? Date.now()
  item.status = status
  item.leaseExpiresAt = undefined
  if (options.error) item.error = options.error
  item.updatedAt = new Date(now).toISOString()
  state.updatedAt = item.updatedAt
  return item
}

/**
 * Attribute token usage to the item handled by a session.
 *
 * The data comes from the host's `llm.completed` hook, which reports
 * prompt/completion/total tokens plus the CACHED prompt tokens and the
 * cache-write tokens. Tracking the cache counters is what makes the
 * "cost / cache" observation possible.
 */
export function recordTokenUsage(
  state: ControlPlaneState,
  sessionId: string,
  usage: Partial<TokenUsage>,
  options: { now?: number; maxTokensPerIssue?: number } = {},
): WorkItem | null {
  const item = Object.values(state.items).find((i) => i.sessionId === sessionId)
  if (!item) return null
  const now = options.now ?? Date.now()
  item.tokens.promptTokens += usage.promptTokens ?? 0
  item.tokens.completionTokens += usage.completionTokens ?? 0
  item.tokens.totalTokens += usage.totalTokens ?? 0
  item.tokens.cachedPromptTokens += usage.cachedPromptTokens ?? 0
  item.tokens.cacheWriteTokens += usage.cacheWriteTokens ?? 0
  item.tokens.llmCalls += usage.llmCalls ?? 0
  item.updatedAt = new Date(now).toISOString()
  state.updatedAt = item.updatedAt

  // The budget is enforced on the LIVE run too, not only at reservation:
  // a run that was already reserved keeps spending tokens, and the budget
  // must stop it instead of only blocking the NEXT reservation.
  const budget = options.maxTokensPerIssue ?? 0
  if (budget > 0 && item.tokens.totalTokens >= budget && item.status === 'running') {
    item.status = 'blocked'
    item.error = `token budget exceeded (${item.tokens.totalTokens}/${budget})`
    item.updatedAt = new Date(now).toISOString()
    state.updatedAt = item.updatedAt
  }
  return item
}

export interface ControlPlaneMetrics {
  total: number
  queued: number
  reserved: number
  running: number
  done: number
  failed: number
  blocked: number
  cancelled: number
  /** Workers in use right now. */
  activeWorkers: number
  maxWorkers: number
  /** Total tokens across all items. */
  totalTokens: number
  /** Cached prompt tokens across all items. */
  cachedPromptTokens: number
  /** Cache hit ratio over the whole registry (0..1). */
  cacheHitRatio: number
  /** Average tokens per finished item. */
  avgTokensPerItem: number
  /** Per-issue token usage, for the UI. */
  perItem: Array<{ key: string; totalTokens: number; cachedPromptTokens: number; llmCalls: number }>
}

export function computeControlPlaneMetrics(
  state: ControlPlaneState,
  options: { maxWorkers?: number } = {},
): ControlPlaneMetrics {
  const items = Object.values(state.items)
  const count = (status: WorkItemStatus): number => items.filter((i) => i.status === status).length
  const totalTokens = items.reduce((sum, i) => sum + i.tokens.totalTokens, 0)
  const cachedPromptTokens = items.reduce((sum, i) => sum + i.tokens.cachedPromptTokens, 0)
  const promptTokens = items.reduce((sum, i) => sum + i.tokens.promptTokens, 0)
  const finished = items.filter((i) => i.status === 'done' || i.status === 'failed')

  return {
    total: items.length,
    queued: count('queued'),
    reserved: count('reserved'),
    running: count('running'),
    done: count('done'),
    failed: count('failed'),
    blocked: count('blocked'),
    cancelled: count('cancelled'),
    activeWorkers: count('running') + count('reserved'),
    maxWorkers: options.maxWorkers ?? DEFAULT_CONTROL_PLANE_OPTIONS.maxWorkers,
    totalTokens,
    cachedPromptTokens,
    cacheHitRatio: promptTokens > 0 ? cachedPromptTokens / promptTokens : 0,
    avgTokensPerItem: finished.length > 0 ? Math.round(totalTokens / finished.length) : 0,
    perItem: items.map((i) => ({
      key: i.key,
      totalTokens: i.tokens.totalTokens,
      cachedPromptTokens: i.tokens.cachedPromptTokens,
      llmCalls: i.tokens.llmCalls,
    })),
  }
}

/**
 * Parse a stored registry, tolerating corruption.
 *
 * The host's storage is JSON; a partially written or hand-edited value
 * must not crash the plugin. An unusable payload yields an empty registry.
 */
export function parseControlPlaneState(raw: unknown): ControlPlaneState {
  if (typeof raw !== 'object' || raw === null) return emptyControlPlaneState()
  const candidate = raw as Partial<ControlPlaneState>
  if (
    typeof candidate.version !== 'number' ||
    typeof candidate.items !== 'object' ||
    candidate.items === null
  ) {
    return emptyControlPlaneState()
  }
  const items: Record<string, WorkItem> = {}
  for (const [key, value] of Object.entries(candidate.items)) {
    if (typeof value === 'object' && value !== null) {
      items[key] = value as WorkItem
    }
  }
  return {
    version: candidate.version,
    items,
    sequence: typeof candidate.sequence === 'number' ? candidate.sequence : Object.keys(items).length,
    updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : new Date(0).toISOString(),
  }
}
