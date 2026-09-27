/**
 * Session spawner.
 *
 * Uses `context.host` (Plugin API v2.1+) when available, with fallback
 * to `context.openFoxInternals` (legacy) and finally to a dynamic import.
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