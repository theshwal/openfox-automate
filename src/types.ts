/**
 * Shared types for openfox-automate.
 */

export type QueueStatus = 'queued' | 'running' | 'blocked' | 'done' | 'failed' | 'cancelled'

export type OrderingStrategy = 'default' | 'priority-labels' | 'strict-deps'

export type ExecutionStepStatus = 'pending' | 'running' | 'done' | 'blocked' | 'waiting'

export interface QueueEntry {
  id: string
  repoKey: string
  projectId: string
  issueNumber: number
  title: string
  body: string
  url: string
  labels: string[]
  comments: IssueComment[]
  dependsOn: number[]
  status: QueueStatus
  position: number
  sessionId?: string
  executionStack?: ExecutionStep[]
  error?: string
  addedAt: string
  startedAt?: string
  finishedAt?: string
  commentUrl?: string
  prUrl?: string
}

export interface IssueComment {
  author: string
  body: string
  createdAt: string
}

export interface ExecutionStep {
  workflowId: string
  workflowName: string
  status: ExecutionStepStatus
  retryCount: number
  startedAt?: string
  finishedAt?: string
}

export interface RepoMapping {
  repoKey: string
  projectId: string
}

export interface ChainConfig {
  global: string[]
  byRepo: Map<string, string[]>
}

export interface HealthReport {
  github: {
    tokenValid: boolean
    rateLimitRemaining: number
    reposAccessible: Record<string, 'ok' | '404' | '403' | 'unknown'>
  }
  openFoxInternals: {
    sessionManager: 'ok' | 'missing'
    launchWorkflowRun: 'ok' | 'missing'
    host: 'ok' | 'missing'
  }
  workflows: Record<string, 'ok' | 'not-found'>
  projects: Record<string, 'ok' | 'missing'>
  mapping: { valid: boolean; issues: string[] }
}

export interface PluginSettings {
  'github.token'?: string
  'repos.mapping'?: string
  'workflows.chain'?: string
  'workflows.repoOverrides'?: string
  'scan.refreshMinutes'?: number
  'scan.startupScan'?: boolean
  'scan.ignoreLabels'?: string
  'batch.maxConcurrency'?: number
  'batch.maxConcurrencyPerRepo'?: number
  'ordering.strategy'?: OrderingStrategy
  'ordering.dependencyPattern'?: string
  dryRun?: boolean
  'history.retentionCount'?: number
  'post.closeOnSuccess'?: boolean
  'post.assignOnSuccess'?: boolean
  'post.commentTemplate'?: string
  'post.reprocessResetsRetryCount'?: boolean
  'pr.monitorEnabled'?: boolean
  'pr.urlRegex'?: string
}

export const DEFAULT_SETTINGS: Required<
  Omit<
    PluginSettings,
    | 'github.token'
    | 'repos.mapping'
    | 'workflows.repoOverrides'
    | 'post.commentTemplate'
    | 'ordering.dependencyPattern'
    | 'pr.urlRegex'
  >
> = {
  'workflows.chain': 'plan-issue-v3\nbuild-verify-v3\npublish-pr-v1',
  'scan.refreshMinutes': 30,
  'scan.startupScan': true,
  'scan.ignoreLabels': 'wontfix,duplicate,needs-discussion',
  'batch.maxConcurrency': 3,
  'batch.maxConcurrencyPerRepo': 2,
  'ordering.strategy': 'default',
  dryRun: false,
  'history.retentionCount': 100,
  'post.closeOnSuccess': false,
  'post.assignOnSuccess': false,
  'post.reprocessResetsRetryCount': true,
  'pr.monitorEnabled': true,
}
