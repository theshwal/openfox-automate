/**
 * Internal port/adapter for OpenFox orchestration.
 *
 * The state machine in the plugin talks only to this interface, which
 * keeps it testable and decoupled from the concrete shape of the
 * PluginContext API exposed by the host (the discriminated union in
 * resolve-openfox.js).
 */
import type { PluginContext } from 'openfox/plugin';
import { HostClient } from './host-client.js';
export interface SessionLike {
    id: string;
    workdir?: string;
}
export interface LaunchWorkflowParams {
    sessionId: string;
    workflowId: string;
    params?: Record<string, string>;
    content?: string;
    subGroup?: string;
}
/**
 * Default implementation that bridges to whichever host surface is exposed.
 *
 * The order is deliberate:
 *
 *   1. `context.host` — an in-process facade, when the host provides one;
 *   2. `context.openFoxInternals` — the legacy in-process surface;
 *   3. the SUPPORTED HTTP API (`src/host-client.ts`).
 *
 * The third path matters: OpenFox 2.0.160 and 2.0.161 expose NEITHER
 * in-process surface to a plugin (`PluginContext` declares no `host` and no
 * `openFoxInternals`, and the package does not export `sessionManager` nor
 * `launchWorkflowRun`), so without the HTTP path the plugin could not
 * create a session at all on a real host. The HTTP path is fail-closed:
 * it only runs when a base URL is configured, and every failure is
 * reported as a typed error.
 */
export interface OpenFoxOrchestration {
    createSession(projectId: string, title: string): Promise<SessionLike>;
    stopSession(sessionId: string): Promise<void> | void;
    launchWorkflow(params: LaunchWorkflowParams): void;
}
export interface OrchestrationDeps {
    createSession?: (projectId: string, title: string) => Promise<SessionLike>;
    stopSession?: (sessionId: string) => Promise<void> | void;
    launchWorkflow?: (params: LaunchWorkflowParams) => void;
}
/**
 * The HTTP client used when no in-process surface is available.
 *
 * It is created lazily and only when the plugin was configured with a
 * host base URL: an unconfigured plugin never performs a request.
 */
export interface HttpClientFactory {
    (): HostClient | null;
}
export declare function defaultHttpClientFactory(context: PluginContext): HttpClientFactory;
export declare function createHostOrchestration(context: PluginContext, httpClientFactory?: HttpClientFactory): OpenFoxOrchestration;
export declare function createOrchestration(context: PluginContext, deps?: OrchestrationDeps): OpenFoxOrchestration;
//# sourceMappingURL=orchestration.d.ts.map