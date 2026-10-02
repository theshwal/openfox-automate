/**
 * Workflow chain orchestrator.
 *
 * Given a session + a chain of workflow IDs, this module:
 *  1. Launches workflow 1 of the chain with the issue context as params.
 *  2. Listens for `workflow.execution.changed` events.
 *  3. On `done`: advances to the next workflow in the chain.
 *  4. On `blocked`: retries once, then pauses + notifies user.
 *  5. On full chain completion: marks the queue entry `done`.
 *
 * The actual `launchWorkflowRun` call is delegated to the host via the
 * `LaunchDriver` interface — in production this is the OpenFox runtime
 * resolved by `resolve-openfox.ts`, in tests it is an injected fake.
 */

import type { ExecutionStep, QueueEntry } from './types.js'

export interface ChainContext {
  entry: QueueEntry
  chain: string[]
  currentStepIndex: number
}

export interface LaunchDriver {
  launch(params: LaunchParams): void
}

export interface LaunchParams {
  sessionId: string
  workflowId: string
  content: string
  params: Record<string, string>
}

export function buildIssueContext(entry: QueueEntry): string {
  const lines: string[] = []
  lines.push(`## GitHub issue ${entry.url}`)
  lines.push('')
  lines.push(`**Repo:** ${entry.repoKey}`)
  lines.push(`**Number:** #${entry.issueNumber}`)
  lines.push(`**Title:** ${entry.title}`)
  lines.push(`**Labels:** ${entry.labels.join(', ') || '(none)'}`)
  lines.push('')
  lines.push('## Body')
  lines.push(entry.body || '_(empty)_')
  if (entry.comments.length > 0) {
    lines.push('')
    lines.push('## Conversation')
    for (const c of entry.comments) {
      lines.push('')
      lines.push(`**${c.author}** (${c.createdAt}):`)
      lines.push(c.body)
    }
  }
  lines.push('')
  lines.push(
    'When this workflow reaches $done, the plugin will automatically start the next workflow in the chain — do not call step_done() early; the plugin orchestrates the chain.',
  )
  return lines.join('\n')
}

export function buildIssueParams(entry: QueueEntry): Record<string, string> {
  return {
    // `issue_ref` is a REQUIRED parameter of plan-issue / plan-issue-v3. The
    // host refuses to launch a workflow whose required params are missing
    // (src/server/runner/orchestrator.ts), so the chain could never start the
    // planning step. The id is the stable, already-resolved target: the entry
    // exists precisely because this issue was scanned and queued.
    issue_ref: `${entry.repoKey}#${entry.issueNumber}`,
    issue_url: entry.url,
    issue_number: String(entry.issueNumber),
    issue_title: entry.title,
    issue_body: entry.body ?? '',
    issue_labels: entry.labels.join(', '),
    issue_comments: entry.comments.map((c) => `${c.author}: ${c.body}`).join('\n\n'),
    repo_key: entry.repoKey,
    project_id: entry.projectId,
  }
}

export function initExecutionStack(chain: string[]): ExecutionStep[] {
  return chain.map((id) => ({
    workflowId: id,
    workflowName: id,
    status: 'pending' as const,
    retryCount: 0,
  }))
}

export interface ChainOutcome {
  nextStepIndex: number
  finished: boolean
  blocked: boolean
  waiting: boolean
}

export function applyExecutionEvent(
  stack: ExecutionStep[],
  currentIndex: number,
  event: { status: 'pending' | 'running' | 'done' | 'blocked' | 'waiting' },
): ChainOutcome {
  const step = stack[currentIndex]
  if (!step) return { nextStepIndex: currentIndex, finished: true, blocked: false, waiting: false }
  // 'waiting' (e.g. a user step is awaiting input) does not advance the chain.
  // Subsequent 'running' / 'done' events on the same step clear the wait.
  if (event.status === 'waiting') {
    step.status = 'waiting'
    return { nextStepIndex: currentIndex, finished: false, blocked: false, waiting: true }
  }
  // Resume the step from any non-waiting status (covers user choice clearing
  // the wait without forcing a full status overwrite on the existing entry).
  if (step.status === 'waiting') {
    step.status = event.status
  } else {
    step.status = event.status
  }
  if (event.status === 'done') {
    step.finishedAt = new Date().toISOString()
    return {
      nextStepIndex: currentIndex + 1,
      finished: currentIndex + 1 >= stack.length,
      blocked: false,
      waiting: false,
    }
  }
  if (event.status === 'blocked') {
    step.retryCount += 1
    if (step.retryCount >= 2) {
      step.finishedAt = new Date().toISOString()
      return { nextStepIndex: currentIndex, finished: true, blocked: true, waiting: false }
    }
    step.status = 'running'
    return { nextStepIndex: currentIndex, finished: false, blocked: false, waiting: false }
  }
  return { nextStepIndex: currentIndex, finished: false, blocked: false, waiting: false }
}

export function startChain(
  entry: QueueEntry,
  driver: LaunchDriver,
  options: { sessionId: string },
): ExecutionStep[] {
  const chain = (entry.executionStack ?? []).map((s) => s.workflowId)
  const stack = initExecutionStack(chain)
  if (chain.length === 0) return stack
  stack[0]!.status = 'running'
  stack[0]!.startedAt = new Date().toISOString()
  driver.launch({
    sessionId: options.sessionId,
    workflowId: chain[0]!,
    content: buildIssueContext(entry),
    params: buildIssueParams(entry),
  })
  return stack
}

/**
 * Event payload for a workflow execution change.
 *
 * `executionId` is REQUIRED by the OpenFox host event type. The plugin
 * refuses to process events that lack it (logged + ignored) to avoid
 * the previous ambiguity where retry events shared their dedup key with
 * the original block event under the (sessionId, workflowId, status)
 * fallback.
 */
export interface WorkflowExecutionChange {
  sessionId?: string | undefined
  workflowId?: string | undefined
  executionId?: string | undefined
  status?: 'pending' | 'running' | 'done' | 'blocked' | undefined
}

export interface ProcessLaunch {
  sessionId: string
  workflowId: string
  content: string
  params: Record<string, string>
}

/**
 * Pure orchestration outcome from processing a workflow.execution.changed
 * event. The caller (the hook) applies side effects (transitions, picks
 * next, posts process). The function itself only mutates the entry's
 * `executionStack` in place via `applyExecutionEvent`.
 */
export interface ProcessWorkflowOutcome {
  /** Workflows to launch (chain advance or retry). */
  launches: ProcessLaunch[]
  /** Status the entry should be transitioned to (if any). */
  transitionTo?: 'done' | 'blocked' | undefined
  /** Reason for `blocked` transition. */
  blockedReason?: string | undefined
  /** The dedup key used (or null if no executionId was provided). */
  dedupKey: string | null
  /** Whether the event was deduplicated. */
  deduplicated: boolean
  /** Whether the chain is finished (last workflow done or final block). */
  finished?: boolean
  /** Whether the workflow is paused waiting for user input. */
  waiting?: boolean
}

export interface ProcessDeps {
  /** Mutable set tracking applied (executionId, status) pairs. */
  appliedExecutionEvents: Set<string>
  /** Optional logger for warnings. */
  log?: (msg: string) => void
  buildIssueContext: (entry: QueueEntry) => string
  buildIssueParams: (entry: QueueEntry) => Record<string, string>
}

/**
 * Process one workflow.execution.changed event against the entry's
 * executionStack. Returns the side-effects the caller should apply
 * (transitions, launches). The function itself only mutates the
 * entry's executionStack via applyExecutionEvent.
 *
 * Idempotency: keyed by `${executionId}:${status}`. Without executionId,
 * the event is rejected (warning + no-op) so we never confuse two
 * distinct retry attempts with the same status.
 */
export function processWorkflowEvent(
  entry: QueueEntry,
  event: WorkflowExecutionChange,
  deps: ProcessDeps,
): ProcessWorkflowOutcome {
  if (!event.sessionId || !event.status) {
    return { launches: [], dedupKey: null, deduplicated: false }
  }
  if (!event.executionId) {
    deps.log?.(
      `[openfox-automate] workflow.execution.changed without executionId: status=${event.status} workflowId=${event.workflowId ?? '?'} sessionId=${event.sessionId}; ignored`,
    )
    return { launches: [], dedupKey: null, deduplicated: false }
  }

  const dedupKey = `${event.executionId}:${event.status}`
  if (deps.appliedExecutionEvents.has(dedupKey)) {
    return { launches: [], dedupKey, deduplicated: true }
  }
  deps.appliedExecutionEvents.add(dedupKey)

  const stack = entry.executionStack ?? []
  const idx = stack.findIndex((s) => s.status === 'running')
  if (idx < 0) {
    return { launches: [], dedupKey, deduplicated: false }
  }
  const prevRetry = stack[idx]!.retryCount
  const outcome = applyExecutionEvent(stack, idx, { status: event.status })

  const launches: ProcessLaunch[] = []
  let transitionTo: 'done' | 'blocked' | undefined
  let blockedReason: string | undefined

  if (outcome.finished && !outcome.blocked) {
    transitionTo = 'done'
  } else if (outcome.blocked) {
    transitionTo = 'blocked'
    blockedReason = `workflow ${event.workflowId ?? stack[idx]!.workflowId} blocked`
  } else if (event.status === 'done' && idx + 1 < stack.length) {
    // Chain advance: launch the next workflow
    const nextStep = stack[idx + 1]!
    if (entry.sessionId) {
      launches.push({
        sessionId: entry.sessionId,
        workflowId: nextStep.workflowId,
        content: deps.buildIssueContext(entry),
        params: deps.buildIssueParams(entry),
      })
    }
  } else if (event.status === 'blocked' && stack[idx]!.retryCount > prevRetry) {
    // Retry-once kicked in: relaunch the same workflow.
    if (entry.sessionId) {
      launches.push({
        sessionId: entry.sessionId,
        workflowId: stack[idx]!.workflowId,
        content: deps.buildIssueContext(entry),
        params: deps.buildIssueParams(entry),
      })
    }
  }

  return {
    launches,
    transitionTo,
    blockedReason,
    dedupKey,
    deduplicated: false,
    finished: outcome.finished,
    waiting: outcome.waiting,
  }
}

/**
 * Remove all dedup keys for a given sessionId. Call this when an entry
 * transitions to a terminal status (done/blocked/cancelled) so the
 * appliedExecutionEvents Set doesn't grow unbounded over a long-running
 * OpenFox instance.
 */
export function purgeAppliedExecutionEvents(set: Set<string>, predicate: (key: string) => boolean): void {
  for (const key of [...set]) {
    if (predicate(key)) set.delete(key)
  }
}
