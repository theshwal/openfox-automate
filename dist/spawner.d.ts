/**
 * Session spawner.
 *
 * Uses `context.openFoxInternals` (host-exposed) to create sessions.
 * The actual workflow chain driving is delegated to `chain.ts`.
 *
 * In tests, the spawner takes an injected `createSession` function so unit
 * tests do not need a real OpenFox host.
 */
import type { PluginContext } from 'openfox/plugin';
import type { QueueEntry } from './types.js';
export interface SessionLike {
    id: string;
    workdir?: string;
}
export interface SpawnerDeps {
    createSession?: (projectId: string, title: string) => Promise<SessionLike>;
    context?: PluginContext;
}
export declare function buildSessionTitle(entry: QueueEntry): string;
export declare function spawnSessionFor(entry: QueueEntry, deps?: SpawnerDeps): Promise<SessionLike>;
export declare function stopSession(sessionId: string, deps?: {
    stopSession?: (id: string) => Promise<void>;
    context?: PluginContext;
}): Promise<void>;
//# sourceMappingURL=spawner.d.ts.map