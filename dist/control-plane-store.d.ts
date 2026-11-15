/**
 * Durable store for the control plane registry.
 *
 * The whole registry lives in ONE storage key, so the host's JSON
 * round-trip makes each write atomic with respect to the other keys. The
 * previous design spread the state over `queue` + `history` and rewrote
 * whole arrays on every mutation, which allowed two concurrent writers
 * (the scan timer and the workflow hook) to lose each other's work.
 */
import type { ControlPlaneOptions, ControlPlaneState } from './control-plane.js';
import { emptyControlPlaneState } from './control-plane.js';
export declare const CONTROL_PLANE_STORAGE_KEY = "control_plane";
export interface ControlPlaneStorage {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
}
export declare class ControlPlaneStore {
    private readonly storage;
    constructor(storage: ControlPlaneStorage);
    /**
     * Load the registry.
     *
     * A corrupted payload yields an empty registry rather than an
     * exception: a broken store must not take the plugin down.
     */
    load(): Promise<ControlPlaneState>;
    /** Persist the registry. */
    save(state: ControlPlaneState): Promise<void>;
    /**
     * Read-modify-write, serialized.
     *
     * Every mutation of the registry goes through this helper, and the
     * promise chain guarantees that two concurrent callers cannot interleave
     * their read and their write.
     */
    private tail;
    mutate<T>(fn: (state: ControlPlaneState) => T): Promise<T>;
    /** Read-only view. */
    read<T>(fn: (state: ControlPlaneState) => T): Promise<T>;
}
/**
 * Build the control-plane options from the plugin settings.
 *
 * The capacities are CLAMPED here (the settings are user input): the
 * global worker count is capped at 5, as required, and the per-repository
 * count never exceeds the global one.
 */
export declare function controlPlaneOptionsFromSettings(settings: {
    'batch.maxConcurrency'?: number;
    'batch.maxConcurrencyPerRepo'?: number;
    'budget.maxTokensPerIssue'?: number;
    'control.leaseMinutes'?: number;
}): ControlPlaneOptions;
export { emptyControlPlaneState };
//# sourceMappingURL=control-plane-store.d.ts.map