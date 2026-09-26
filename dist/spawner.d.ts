/**
 * Session spawner.
 *
 * Resolves OpenFox internals and uses the host `sessionManager` to create
 * sessions. The actual workflow chain driving is delegated to `chain.ts`.
 *
 * In production this relies on the dynamic import in `resolve-openfox.ts`.
 * In tests, the spawner takes an injected `createSession` function so unit
 * tests do not need a real OpenFox host.
 */
import type { QueueEntry } from './types.js';
export interface SessionLike {
    id: string;
    workdir?: string;
}
export interface SpawnerDeps {
    createSession?: (projectId: string, title: string) => Promise<SessionLike>;
}
export declare function buildSessionTitle(entry: QueueEntry): string;
export declare function spawnSessionFor(entry: QueueEntry, deps?: SpawnerDeps): Promise<SessionLike>;
export declare function stopSession(sessionId: string, deps?: {
    stopSession?: (id: string) => Promise<void>;
}): Promise<void>;
//# sourceMappingURL=spawner.d.ts.map