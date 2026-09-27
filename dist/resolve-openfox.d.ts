/**
 * OpenFox internals resolver.
 *
 * Prefers the host-exposed `context.openFoxInternals` (apiVersion 2,
 * added by the host when it wires sessionManager + runWorkflow into
 * the plugin context). Falls back to a dynamic import of the host's
 * dist/server for older hosts that don't expose internals yet.
 */
import type { PluginContext } from 'openfox/plugin';
/**
 * Local shape matching the host-exposed openFoxInternals.
 * (Defined here as well as a fallback until the host npm package
 * exports PluginOpenFoxInternals.)
 */
export interface PluginOpenFoxInternalsLocal {
    sessionManager: {
        createSession: (projectId: string, title: string) => Promise<{
            id: string;
            workdir?: string;
        }>;
        setRunning: (sessionId: string, running: boolean) => void;
    };
    runWorkflow: (sessionId: string, payload: unknown) => void;
}
export type OpenFoxInternals = PluginOpenFoxInternalsLocal;
export declare function getOpenFoxInternals(context?: PluginContext): Promise<OpenFoxInternals | null>;
export declare function getOpenFoxInternalsSync(context: PluginContext | undefined): OpenFoxInternals | null;
export declare function getResolveError(): string | null;
export declare function isOpenFoxInternalsAvailable(): boolean;
export declare function _resetForTesting(): void;
//# sourceMappingURL=resolve-openfox.d.ts.map