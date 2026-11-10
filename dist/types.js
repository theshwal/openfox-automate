/**
 * Shared types for openfox-automate.
 */
export const DEFAULT_SETTINGS = {
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
};
//# sourceMappingURL=types.js.map