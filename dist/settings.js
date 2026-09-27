/**
 * Settings schema for openfox-automate.
 *
 * Each field is rendered automatically in the Plugins tab form. Secrets
 * (password type with secret:true) are masked on read and preserved on
 * empty submit. See docs/PLUGINS.md § Settings for the full contract.
 */
export const settingsSchema = {
    fields: [
        {
            key: 'github.token',
            type: 'password',
            label: { en: 'GitHub Personal Access Token', fr: 'Jeton d’accès personnel GitHub' },
            description: {
                en: 'Fine-grained PAT with `repo` and `read:org` scopes for private repositories.',
                fr: 'Jeton à granularité fine avec les portées `repo` et `read:org` pour les dépôts privés.',
            },
            secret: true,
        },
        {
            key: 'repos.mapping',
            type: 'textarea',
            label: { en: 'Repository mapping', fr: 'Mappage des dépôts' },
            description: {
                en: 'One `owner/repo=projectId` per line. Lines starting with `#` and blank lines are ignored.',
                fr: 'Une ligne `owner/repo=projectId`. Les lignes commençant par `#` et les lignes vides sont ignorées.',
            },
            default: '',
        },
        {
            key: 'workflows.chain',
            type: 'textarea',
            label: { en: 'Workflow chain', fr: 'Chaîne de workflows' },
            description: {
                en: 'Ordered workflow IDs, one per line. Default: Plan Issue v2 → Build & Verify Auto v2 → Delivery v2.',
                fr: 'Identifiants de workflows ordonnés, un par ligne. Défaut : Plan Issue v2 → Build & Verify Auto v2 → Delivery v2.',
            },
            default: 'Plan Issue v2\nBuild & Verify Auto v2\nDelivery v2',
        },
        {
            key: 'workflows.repoOverrides',
            type: 'textarea',
            label: { en: 'Workflow chain overrides per repo', fr: 'Surcharges de chaîne par dépôt' },
            description: {
                en: 'One `owner/repo=w1,w2,w3` per line. Empty means the global chain applies.',
                fr: 'Une ligne `owner/repo=w1,w2,w3` par ligne. Vide signifie que la chaîne globale s’applique.',
            },
            default: '',
        },
        {
            key: 'scan.refreshMinutes',
            type: 'number',
            label: {
                en: 'Scan refresh interval (minutes)',
                fr: 'Intervalle de rafraîchissement du scan (minutes)',
            },
            default: 30,
        },
        {
            key: 'scan.startupScan',
            type: 'boolean',
            label: { en: 'Run a scan immediately on plugin start', fr: 'Lancer un scan au démarrage du plugin' },
            default: true,
        },
        {
            key: 'scan.ignoreLabels',
            type: 'textarea',
            label: { en: 'Labels to ignore', fr: 'Labels à ignorer' },
            description: {
                en: 'Comma-separated. Issues carrying any of these labels are skipped.',
                fr: 'Séparés par des virgules. Les issues portant un de ces labels sont ignorées.',
            },
            default: 'wontfix,duplicate,needs-discussion',
        },
        {
            key: 'batch.maxConcurrency',
            type: 'number',
            label: { en: 'Max simultaneous sessions (global)', fr: 'Sessions simultanées max (global)' },
            default: 3,
        },
        {
            key: 'batch.maxConcurrencyPerRepo',
            type: 'number',
            label: { en: 'Max simultaneous sessions per repo', fr: 'Sessions simultanées max par dépôt' },
            default: 2,
        },
        {
            key: 'ordering.strategy',
            type: 'select',
            label: { en: 'Ordering strategy', fr: 'Stratégie de tri' },
            options: [
                {
                    value: 'default',
                    label: {
                        en: 'Default (deps + bug-first + FIFO)',
                        fr: 'Défaut (dépendances + bugs d’abord + FIFO)',
                    },
                },
                { value: 'priority-labels', label: { en: 'Priority labels', fr: 'Labels de priorité' } },
                {
                    value: 'strict-deps',
                    label: { en: 'Strict dependencies (topological)', fr: 'Dépendances strictes (topologique)' },
                },
            ],
            default: 'default',
        },
        {
            key: 'ordering.dependencyPattern',
            type: 'text',
            label: { en: 'Dependency pattern (regex)', fr: 'Motif de dépendance (regex)' },
            default: '(#(\\d+)|depends on #(\\d+)|blocked by #(\\d+))',
        },
        {
            key: 'dryRun',
            type: 'boolean',
            label: {
                en: 'Dry run (no sessions created, no GitHub writes)',
                fr: 'Simulation (aucune session créée, aucune écriture GitHub)',
            },
            default: false,
        },
        {
            key: 'history.retentionCount',
            type: 'number',
            label: { en: 'History retention count', fr: 'Nombre d’entrées conservées dans l’historique' },
            default: 100,
        },
        {
            key: 'post.closeOnSuccess',
            type: 'boolean',
            label: { en: 'Close issue on success', fr: 'Fermer l’issue en cas de succès' },
            default: false,
        },
        {
            key: 'post.assignOnSuccess',
            type: 'boolean',
            label: { en: 'Assign issue to me on success', fr: 'M’assigner l’issue en cas de succès' },
            default: false,
        },
        {
            key: 'post.commentTemplate',
            type: 'textarea',
            label: { en: 'Comment template', fr: 'Modèle de commentaire' },
            description: {
                en: 'Supports {{title}}, {{summary}}, {{sessionUrl}}, {{prUrl}}. Empty by default (Delivery v2 handles comments).',
                fr: 'Supporte {{title}}, {{summary}}, {{sessionUrl}}, {{prUrl}}. Vide par défaut (Delivery v2 gère les commentaires).',
            },
            default: '',
        },
        {
            key: 'post.reprocessResetsRetryCount',
            type: 'boolean',
            label: {
                en: 'Re-process resets retry count',
                fr: 'Le retraitement remet à zéro le compteur de tentatives',
            },
            default: true,
        },
        {
            key: 'pr.monitorEnabled',
            type: 'boolean',
            label: {
                en: 'Monitor opened PRs (conflicts / merges)',
                fr: 'Surveiller les PR ouvertes (conflits / fusions)',
            },
            default: true,
        },
        {
            key: 'pr.urlRegex',
            type: 'text',
            label: { en: 'GitHub PR URL regex', fr: 'Regex des URL de PR GitHub' },
            default: 'https://github\\.com/[^/]+/[^/]+/pull/(\\d+)',
        },
    ],
};
import { DEFAULT_SETTINGS } from './types.js';
export function readSettings(raw) {
    const merged = { ...DEFAULT_SETTINGS };
    for (const [k, v] of Object.entries(raw)) {
        if (v !== undefined && v !== null && v !== '')
            merged[k] = v;
    }
    return clampSettings(merged);
}
/**
 * Clamp / validate plugin settings to safe ranges.
 *
 * Host-side validation rejects negative / zero numeric values, but the
 * plugin applies its own defensive clamps so behavior is consistent
 * regardless of the host's validator. Negative / non-finite values fall
 * back to the default.
 */
export function clampSettings(settings) {
    const out = { ...settings };
    const minutes = Number(out['scan.refreshMinutes']);
    if (!Number.isFinite(minutes) || minutes < 1) {
        out['scan.refreshMinutes'] = 30;
    }
    else if (minutes > 60) {
        out['scan.refreshMinutes'] = 60;
    }
    else {
        out['scan.refreshMinutes'] = Math.floor(minutes);
    }
    const global = Number(out['batch.maxConcurrency']);
    if (!Number.isFinite(global) || global < 1) {
        out['batch.maxConcurrency'] = 3;
    }
    else if (global > 10) {
        out['batch.maxConcurrency'] = 10;
    }
    else {
        out['batch.maxConcurrency'] = Math.floor(global);
    }
    const perRepo = Number(out['batch.maxConcurrencyPerRepo']);
    if (!Number.isFinite(perRepo) || perRepo < 1) {
        out['batch.maxConcurrencyPerRepo'] = 2;
    }
    else if (perRepo > 5) {
        out['batch.maxConcurrencyPerRepo'] = 5;
    }
    else {
        out['batch.maxConcurrencyPerRepo'] = Math.floor(perRepo);
    }
    const retention = Number(out['history.retentionCount']);
    if (!Number.isFinite(retention) || retention < 10) {
        out['history.retentionCount'] = 100;
    }
    else if (retention > 500) {
        out['history.retentionCount'] = 500;
    }
    else {
        out['history.retentionCount'] = Math.floor(retention);
    }
    return out;
}
export function parseRepoMapping(text) {
    if (!text)
        return [];
    const result = [];
    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#'))
            continue;
        const eq = line.indexOf('=');
        if (eq <= 0)
            continue;
        const repoKey = line.slice(0, eq).trim();
        const projectId = line.slice(eq + 1).trim();
        if (!repoKey.includes('/'))
            continue;
        if (!projectId)
            continue;
        result.push({ repoKey, projectId });
    }
    return result;
}
export function parseChain(text) {
    if (!text)
        return [];
    return text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('#'));
}
export function parseRepoOverrides(text) {
    const map = new Map();
    if (!text)
        return map;
    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#'))
            continue;
        const eq = line.indexOf('=');
        if (eq <= 0)
            continue;
        const repoKey = line.slice(0, eq).trim();
        const chainPart = line.slice(eq + 1).trim();
        if (!repoKey.includes('/'))
            continue;
        const chain = chainPart
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        if (chain.length > 0)
            map.set(repoKey, chain);
    }
    return map;
}
export function parseIgnoreLabels(text) {
    if (!text)
        return [];
    return text
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0);
}
//# sourceMappingURL=settings.js.map