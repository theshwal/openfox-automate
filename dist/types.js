/**
 * Shared types for openfox-automate.
 */
export const DEFAULT_SETTINGS = {
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
};
//# sourceMappingURL=types.js.map