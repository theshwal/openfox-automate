/**
 * Queue state store.
 *
 * Persists in context.storage under:
 *   "queue": QueueEntry[]              (active entries)
 *   "history": QueueEntry[]            (terminated entries)
 *
 * The plugin only reads/writes via the storage passed at construction.
 */
const VALID_TRANSITIONS = {
    queued: ['running', 'cancelled', 'removed'],
    running: ['blocked', 'done', 'failed', 'cancelled'],
    blocked: ['running', 'failed', 'cancelled', 'queued'],
    done: ['queued'],
    failed: ['queued'],
    cancelled: ['queued'],
};
export function canTransition(from, to) {
    if (from === to)
        return false;
    return (VALID_TRANSITIONS[from] ?? []).includes(to);
}
export function assertTransition(from, to) {
    if (!canTransition(from, to)) {
        throw new Error(`Invalid queue transition: ${from} → ${to}`);
    }
}
export function dedupKey(repoKey, issueNumber) {
    return `${repoKey}#${issueNumber}`;
}
const STORAGE_QUEUE = 'queue';
const STORAGE_HISTORY = 'history';
export class QueueStore {
    storage;
    constructor(storage) {
        this.storage = storage;
    }
    async loadActive() {
        const raw = (await this.storage.get(STORAGE_QUEUE));
        return Array.isArray(raw) ? raw : [];
    }
    async loadHistory() {
        const raw = (await this.storage.get(STORAGE_HISTORY));
        return Array.isArray(raw) ? raw : [];
    }
    async saveActive(entries) {
        await this.storage.set(STORAGE_QUEUE, entries);
    }
    async saveHistory(entries) {
        await this.storage.set(STORAGE_HISTORY, entries);
    }
    async addNew(candidates) {
        const active = await this.loadActive();
        const existing = new Set(active.map((e) => dedupKey(e.repoKey, e.issueNumber)));
        const fresh = candidates.filter((c) => !existing.has(dedupKey(c.repoKey, c.issueNumber)));
        if (fresh.length > 0) {
            const next = [...active, ...fresh];
            await this.saveActive(next);
        }
        return { added: fresh, skipped: candidates.length - fresh.length };
    }
    async replace(entries) {
        await this.saveActive(entries);
    }
    async findById(id) {
        const active = await this.loadActive();
        return active.find((e) => e.id === id);
    }
    async update(entry) {
        const active = await this.loadActive();
        const idx = active.findIndex((e) => e.id === entry.id);
        if (idx < 0)
            throw new Error(`Queue entry not found: ${entry.id}`);
        active[idx] = entry;
        await this.saveActive(active);
        return entry;
    }
    async transitionTo(id, next, patch = {}) {
        const active = await this.loadActive();
        const idx = active.findIndex((e) => e.id === id);
        if (idx < 0)
            throw new Error(`Queue entry not found: ${id}`);
        const current = active[idx];
        assertTransition(current.status, next);
        const updated = { ...current, ...patch, status: next };
        active[idx] = updated;
        if (isTerminated(next)) {
            const terminated = { ...updated, finishedAt: updated.finishedAt ?? new Date().toISOString() };
            active.splice(idx, 1);
            const history = await this.loadHistory();
            history.unshift(terminated);
            await this.saveActive(active);
            await this.saveHistory(history);
            return terminated;
        }
        await this.saveActive(active);
        return updated;
    }
    async remove(id) {
        const active = await this.loadActive();
        const next = active.filter((e) => e.id !== id);
        await this.saveActive(next);
    }
    async pruneHistory(retention) {
        const history = await this.loadHistory();
        if (history.length <= retention)
            return;
        const sorted = [...history].sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''));
        const kept = sorted.slice(0, retention);
        await this.saveHistory(kept);
    }
}
export function isTerminated(status) {
    return status === 'done' || status === 'failed' || status === 'cancelled';
}
export function newEntryId() {
    return `qe_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
//# sourceMappingURL=queue.js.map