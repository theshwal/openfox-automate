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
  /**
   * The id of the HOST TASK the launch created on the host's task board.
   *
   * The host only frees a worker slot when its task leaves the
   * "in_progress" state, so the task must be closed when the chain ends —
   * otherwise the host's slot limit is consumed forever and the next issue
   * never starts.
   */
  hostTaskId?: string | undefined
  /** The host project the task belongs to. */
  hostProjectId?: string | undefined
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
  /**
   * How the plugin reaches the host.
   *
   * The HTTP path is the only one available to a plugin on the current
   * host: `PluginContext` exposes neither `host` nor
   * `openFoxInternals`.
   */
  host: {
    baseUrl: string
    /** True when the base URL comes from the operator's settings. */
    baseUrlConfigured: boolean
    tokenConfigured: boolean
    transport: 'http' | 'missing'
    inProcess: 'facade' | 'legacy' | 'none'
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
  'budget.maxTokensPerIssue'?: number
  'control.leaseMinutes'?: number
  'host.baseUrl'?: string
  'host.sessionToken'?: string
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
    | 'host.baseUrl'
    | 'host.sessionToken'
  >
> = {
  'workflows.chain': 'plan-issue-v3\nbuild-verify-v3\npublish-pr-v1',
  'scan.refreshMinutes': 30,
  // Safe defaults: the plugin must not start any work on its own.
  // `scan.startupScan` only RE-READS GitHub; the sessions are created
  // exclusively through the explicit `start_issue` / `control_plane_schedule`
  // entry points, and `dryRun` keeps even those inert.
  'scan.startupScan': false,
  'scan.ignoreLabels': 'wontfix,duplicate,needs-discussion',
  'batch.maxConcurrency': 3,
  'batch.maxConcurrencyPerRepo': 2,
  'ordering.strategy': 'default',
  // Dry run ON by default: enabling the plugin never creates a session,
  // never writes to GitHub and never launches a workflow until the
  // operator explicitly turns it off.
  dryRun: true,
  'history.retentionCount': 100,
  'post.closeOnSuccess': false,
  'post.assignOnSuccess': false,
  'post.reprocessResetsRetryCount': true,
  'pr.monitorEnabled': true,
  'budget.maxTokensPerIssue': 0,
  'control.leaseMinutes': 10,
}
