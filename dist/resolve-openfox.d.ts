/**
 * OpenFox internals resolver.
 *
 * Prefers the host-exposed `context.host` (Plugin API v2.1+, exposes
 * `sessions.create / sessions.stop / workflows.launch`). Falls back to the
 * older `context.openFoxInternals` shape for backward compatibility, then to
 * a dynamic import of the host's dist/server for hosts that don't expose
 * either.
 */
import type { PluginContext } from 'openfox/plugin';
/**
 * Minimal surface the plugin needs from the host. The host exposes this via
 * `context.host` on hosts that support plugin orchestration (>=2.1).
 */
export interface PluginHostFacade {
    sessions: {
        create(input: {
            projectId: string;
            title?: string;
        }): Promise<{
            sessionId: string;
            workdir?: string;
        }>;
        stop(sessionId: string): void;
    };
    workflows: {
        launch(input: {
            sessionId: string;
            workflowId: string;
            params?: Record<string, string>;
            content?: string;
            subGroup?: string;
        }): void;
    };
}
/**
 * Legacy surface (apiVersion 2.0). Kept as a fallback for hosts that
 * expose `openFoxInternals` but not the newer `host` shape.
 */
export interface PluginOpenFoxInternalsLegacy {
    sessionManager: {
        createSession: (projectId: string, title: string) => Promise<{
            id: string;
            workdir?: string;
        }>;
        setRunning: (sessionId: string, running: boolean) => void;
    };
    runWorkflow: (sessionId: string, payload: unknown) => void;
}
/** Discriminated union: 'kind' tag identifies the host surface. */
export type PluginHostInternal = {
    kind: 'facade';
    facade: PluginHostFacade;
} | {
    kind: 'legacy';
    legacy: PluginOpenFoxInternalsLegacy;
};
/**
 * The dynamic-import fallback has been REMOVED.
 *
 * It resolved `openfox` and imported `dist/server/session/index.js` and
 * `dist/server/runner/launch.js` — paths that do not exist in the
 * published package (`openfox` only exports `createServer` /
 * `createServerHandle`), so the fallback could never work. It also
 * coupled the plugin to the host's internal module layout, which is not
 * part of the package's `exports` map and moves between releases.
 *
 * The supported replacement is `src/host-client.ts`, which uses the
 * host's documented local HTTP API.
 */
/** Resolve the orchestration surface. */
export declare function getHostInternal(context?: PluginContext): Promise<PluginHostInternal | null>;
export declare function getResolveError(): string | null;
export declare function _resetForTesting(): void;
//# sourceMappingURL=resolve-openfox.d.ts.map