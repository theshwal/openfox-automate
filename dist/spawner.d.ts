/**
 * Session spawner.
 *
 * The plugin creates one session per issue. The host access goes through
 * the ORCHESTRATION PORT (`src/orchestration.ts`), which resolves the
 * host surface in order:
 *
 *   1. `context.host` — an in-process facade, when the host provides one;
 *   2. `context.openFoxInternals` — the legacy in-process surface;
 *   3. the SUPPORTED HTTP API (`src/host-client.ts`).
 *
 * This module used to resolve the host ITSELF, which meant it only knew
 * about paths 1 and 2. On OpenFox 2.0.160 and 2.0.161 the host exposes
 * NEITHER to a plugin, so the plugin could not create a session at all:
 * the session creation failed with "OpenFox host orchestration is not
 * available" even though the plugin already had a working HTTP client.
 */
import type { QueueEntry } from './types.js';
import type { OpenFoxOrchestration } from './orchestration.js';
export interface SessionLike {
    id: string;
    workdir?: string;
}
export interface SpawnerDeps {
    createSession?: (projectId: string, title: string) => Promise<SessionLike>;
    context?: unknown;
    /** The orchestration port; defaults to the host-backed one. */
    orchestration?: OpenFoxOrchestration;
}
export declare function buildSessionTitle(entry: QueueEntry): string;
export declare function spawnSessionFor(entry: QueueEntry, deps?: SpawnerDeps): Promise<SessionLike>;
//# sourceMappingURL=spawner.d.ts.map