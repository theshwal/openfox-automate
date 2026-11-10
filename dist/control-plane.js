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
export const EMPTY_TOKEN_USAGE = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedPromptTokens: 0,
    cacheWriteTokens: 0,
    llmCalls: 0,
};
export function emptyControlPlaneState() {
    return { version: 1, items: {}, sequence: 0, updatedAt: new Date(0).toISOString() };
}
export const DEFAULT_CONTROL_PLANE_OPTIONS = {
    maxWorkers: 5,
    maxWorkersPerRepo: 2,
    leaseMs: 10 * 60_000,
    maxTokensPerIssue: 0,
};
/**
 * Classify an issue the way the admission rules do.
 *
 * `bug` issues come first, then features, then docs, then everything else.
 * Within a class, the insertion order decides (FIFO).
 */
export function classifyLabels(labels) {
    const text = labels.join(' ').toLowerCase();
    if (/\b(bug|fix|defect)\b/.test(text))
        return 'bug';
    if (/\b(feature|enhancement|improvement)\b/.test(text))
        return 'feature';
    if (/\b(doc|documentation)\b/.test(text))
        return 'docs';
    return 'other';
}
const CLASS_RANK = {
    bug: 0,
    feature: 1,
    docs: 2,
    other: 3,
};
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
export function computePriority(labels, sequence) {
    return CLASS_RANK[classifyLabels(labels)] * 1_000_000_000 + sequence;
}
/**
 * Admit candidates into the registry.
 *
 * Idempotent: an item already present is never re-admitted, and the
 * priority of an existing item is never rewritten (so a running item is
 * not re-prioritised under it).
 */
export function admit(state, candidates, options = {}) {
    const now = options.now ?? Date.now();
    const admitted = [];
    let duplicates = 0;
    for (const candidate of candidates) {
        const key = `${candidate.repoKey}#${candidate.issueNumber}`;
        if (state.items[key]) {
            duplicates += 1;
            continue;
        }
        state.sequence += 1;
        const item = {
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
        };
        state.items[key] = item;
        admitted.push(item);
    }
    state.updatedAt = new Date(now).toISOString();
    return { admitted, duplicates };
}
/**
 * Reclaim expired leases.
 *
 * A reservation whose lease expired (the host crashed, the session died)
 * goes back to `queued` so it can be scheduled again. Without this, a
 * crash would permanently leak a worker slot.
 */
export function reclaimExpiredLeases(state, options = {}) {
    const now = options.now ?? Date.now();
    const reclaimed = [];
    for (const item of Object.values(state.items)) {
        if (item.status === 'reserved' || item.status === 'running') {
            if (item.leaseExpiresAt !== undefined && item.leaseExpiresAt <= now) {
                item.status = 'queued';
                item.sessionId = undefined;
                item.leaseExpiresAt = undefined;
                item.error = 'lease expired — reclaimed after an interrupted run';
                item.updatedAt = new Date(now).toISOString();
                reclaimed.push(item);
            }
        }
    }
    if (reclaimed.length > 0)
        state.updatedAt = new Date(now).toISOString();
    return reclaimed;
}
/**
 * An item can run only when every dependency is DONE.
 *
 * A dependency that is unknown (never admitted) leaves the item BLOCKED:
 * the plugin must not start work whose prerequisite is missing.
 */
export function dependencyState(state, item) {
    const missing = [];
    const blocked = [];
    for (const dep of item.dependsOn) {
        const depItem = Object.values(state.items).find((i) => i.repoKey === item.repoKey && i.issueNumber === dep);
        if (!depItem) {
            missing.push(dep);
        }
        else if (depItem.status !== 'done') {
            blocked.push(dep);
        }
    }
    return { satisfied: missing.length === 0 && blocked.length === 0, missing, blocked };
}
/**
 * Reserve worker slots.
 *
 * The scheduler is deterministic: items are considered in priority order,
 * and the FIRST item that can be reserved takes the first free slot. The
 * capacity limits are global and per repository.
 */
export function reserve(state, options) {
    const now = options.now ?? Date.now();
    reclaimExpiredLeases(state, { now });
    const running = Object.values(state.items).filter((i) => i.status === 'running' || i.status === 'reserved');
    const runningByRepo = new Map();
    for (const item of running) {
        runningByRepo.set(item.repoKey, (runningByRepo.get(item.repoKey) ?? 0) + 1);
    }
    const queued = Object.values(state.items)
        .filter((i) => i.status === 'queued')
        .sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key));
    const reserved = [];
    const skipped = [];
    for (const item of queued) {
        const activeCount = running.length + reserved.length;
        if (activeCount >= options.maxWorkers) {
            skipped.push({ key: item.key, reason: 'global worker limit reached' });
            continue;
        }
        const repoCount = (runningByRepo.get(item.repoKey) ?? 0) + reserved.filter((r) => r.repoKey === item.repoKey).length;
        if (repoCount >= options.maxWorkersPerRepo) {
            skipped.push({ key: item.key, reason: 'per-repository worker limit reached' });
            continue;
        }
        const deps = dependencyState(state, item);
        if (!deps.satisfied) {
            if (deps.missing.length > 0) {
                item.status = 'blocked';
                item.error = `missing dependency: ${deps.missing.join(', ')}`;
                item.updatedAt = new Date(now).toISOString();
                skipped.push({ key: item.key, reason: `missing dependency: ${deps.missing.join(', ')}` });
            }
            else {
                skipped.push({ key: item.key, reason: `waiting for dependency: ${deps.blocked.join(', ')}` });
            }
            continue;
        }
        if (options.maxTokensPerIssue > 0 && item.tokens.totalTokens >= options.maxTokensPerIssue) {
            item.status = 'blocked';
            item.error = `token budget exceeded (${item.tokens.totalTokens}/${options.maxTokensPerIssue})`;
            item.updatedAt = new Date(now).toISOString();
            skipped.push({ key: item.key, reason: 'token budget exceeded' });
            continue;
        }
        item.status = 'reserved';
        item.attempt += 1;
        item.leaseExpiresAt = now + options.leaseMs;
        item.updatedAt = new Date(now).toISOString();
        reserved.push(item);
    }
    state.updatedAt = new Date(now).toISOString();
    return { reserved, skipped };
}
/** Attach a session to a reserved item and mark it running. */
export function markRunning(state, key, sessionId, options = {}) {
    const item = state.items[key];
    if (!item)
        return null;
    const now = options.now ?? Date.now();
    item.status = 'running';
    item.sessionId = sessionId;
    item.updatedAt = new Date(now).toISOString();
    state.updatedAt = item.updatedAt;
    return item;
}
/** Mark an item as finished (or failed / cancelled). */
export function completeItem(state, key, status, options = {}) {
    const item = state.items[key];
    if (!item)
        return null;
    const now = options.now ?? Date.now();
    item.status = status;
    item.leaseExpiresAt = undefined;
    if (options.error)
        item.error = options.error;
    item.updatedAt = new Date(now).toISOString();
    state.updatedAt = item.updatedAt;
    return item;
}
/**
 * Attribute token usage to the item handled by a session.
 *
 * The data comes from the host's `llm.completed` hook, which reports
 * prompt/completion/total tokens plus the CACHED prompt tokens and the
 * cache-write tokens. Tracking the cache counters is what makes the
 * "cost / cache" observation possible.
 */
export function recordTokenUsage(state, sessionId, usage, options = {}) {
    const item = Object.values(state.items).find((i) => i.sessionId === sessionId);
    if (!item)
        return null;
    const now = options.now ?? Date.now();
    item.tokens.promptTokens += usage.promptTokens ?? 0;
    item.tokens.completionTokens += usage.completionTokens ?? 0;
    item.tokens.totalTokens += usage.totalTokens ?? 0;
    item.tokens.cachedPromptTokens += usage.cachedPromptTokens ?? 0;
    item.tokens.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
    item.tokens.llmCalls += usage.llmCalls ?? 0;
    item.updatedAt = new Date(now).toISOString();
    state.updatedAt = item.updatedAt;
    return item;
}
export function computeControlPlaneMetrics(state, options = {}) {
    const items = Object.values(state.items);
    const count = (status) => items.filter((i) => i.status === status).length;
    const totalTokens = items.reduce((sum, i) => sum + i.tokens.totalTokens, 0);
    const cachedPromptTokens = items.reduce((sum, i) => sum + i.tokens.cachedPromptTokens, 0);
    const promptTokens = items.reduce((sum, i) => sum + i.tokens.promptTokens, 0);
    const finished = items.filter((i) => i.status === 'done' || i.status === 'failed');
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
    };
}
/**
 * Parse a stored registry, tolerating corruption.
 *
 * The host's storage is JSON; a partially written or hand-edited value
 * must not crash the plugin. An unusable payload yields an empty registry.
 */
export function parseControlPlaneState(raw) {
    if (typeof raw !== 'object' || raw === null)
        return emptyControlPlaneState();
    const candidate = raw;
    if (typeof candidate.version !== 'number' ||
        typeof candidate.items !== 'object' ||
        candidate.items === null) {
        return emptyControlPlaneState();
    }
    const items = {};
    for (const [key, value] of Object.entries(candidate.items)) {
        if (typeof value === 'object' && value !== null) {
            items[key] = value;
        }
    }
    return {
        version: candidate.version,
        items,
        sequence: typeof candidate.sequence === 'number' ? candidate.sequence : Object.keys(items).length,
        updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : new Date(0).toISOString(),
    };
}
//# sourceMappingURL=control-plane.js.map