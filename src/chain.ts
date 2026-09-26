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
}

export function applyExecutionEvent(
  stack: ExecutionStep[],
  currentIndex: number,
  event: { status: 'pending' | 'running' | 'done' | 'blocked' },
): ChainOutcome {
  const step = stack[currentIndex]
  if (!step) return { nextStepIndex: currentIndex, finished: true, blocked: false }
  step.status = event.status
  if (event.status === 'done') {
    step.finishedAt = new Date().toISOString()
    return { nextStepIndex: currentIndex + 1, finished: currentIndex + 1 >= stack.length, blocked: false }
  }
  if (event.status === 'blocked') {
    step.retryCount += 1
    if (step.retryCount >= 2) {
      step.finishedAt = new Date().toISOString()
      return { nextStepIndex: currentIndex, finished: true, blocked: true }
    }
    step.status = 'running'
    return { nextStepIndex: currentIndex, finished: false, blocked: false }
  }
  return { nextStepIndex: currentIndex, finished: false, blocked: false }
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
