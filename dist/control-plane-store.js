/**
 * Durable store for the control plane registry.
 *
 * The whole registry lives in ONE storage key, so the host's JSON
 * round-trip makes each write atomic with respect to the other keys. The
 * previous design spread the state over `queue` + `history` and rewrote
 * whole arrays on every mutation, which allowed two concurrent writers
 * (the scan timer and the workflow hook) to lose each other's work.
 */
import { emptyControlPlaneState, parseControlPlaneState } from './control-plane.js';
export const CONTROL_PLANE_STORAGE_KEY = 'control_plane';
export class ControlPlaneStore {
    storage;
    constructor(storage) {
        this.storage = storage;
    }
    /**
     * Load the registry.
     *
     * A corrupted payload yields an empty registry rather than an
     * exception: a broken store must not take the plugin down.
     */
    async load() {
        const raw = await this.storage.get(CONTROL_PLANE_STORAGE_KEY);
        return parseControlPlaneState(raw);
    }
    /** Persist the registry. */
    async save(state) {
        await this.storage.set(CONTROL_PLANE_STORAGE_KEY, state);
    }
    /**
     * Read-modify-write, serialized.
     *
     * Every mutation of the registry goes through this helper, and the
     * promise chain guarantees that two concurrent callers cannot interleave
     * their read and their write.
     */
    tail = Promise.resolve();
    async mutate(fn) {
        const run = this.tail.then(async () => {
            const state = await this.load();
            const result = fn(state);
            await this.save(state);
            return result;
        });
        // Keep the chain alive even if this mutation rejects.
        this.tail = run.catch(() => undefined);
        return await run;
    }
    /** Read-only view. */
    async read(fn) {
        await this.tail.catch(() => undefined);
        const state = await this.load();
        return fn(state);
    }
}
/**
 * Build the control-plane options from the plugin settings.
 *
 * The capacities are CLAMPED here (the settings are user input): the
 * global worker count is capped at 5, as required, and the per-repository
 * count never exceeds the global one.
 */
export function controlPlaneOptionsFromSettings(settings) {
    const rawGlobal = Number(settings['batch.maxConcurrency']);
    const global = Number.isFinite(rawGlobal) && rawGlobal > 0 ? Math.min(Math.floor(rawGlobal), 5) : 5;
    const rawPerRepo = Number(settings['batch.maxConcurrencyPerRepo']);
    const perRepo = Number.isFinite(rawPerRepo) && rawPerRepo > 0
        ? Math.min(Math.floor(rawPerRepo), global)
        : Math.min(global, 2);
    const rawBudget = Number(settings['budget.maxTokensPerIssue']);
    const budget = Number.isFinite(rawBudget) && rawBudget > 0 ? Math.floor(rawBudget) : 0;
    const rawLease = Number(settings['control.leaseMinutes']);
    const leaseMs = Number.isFinite(rawLease) && rawLease > 0 ? Math.floor(rawLease) * 60_000 : 10 * 60_000;
    return {
        maxWorkers: global,
        maxWorkersPerRepo: perRepo,
        leaseMs,
        maxTokensPerIssue: budget,
    };
}
export { emptyControlPlaneState };
//# sourceMappingURL=control-plane-store.js.map