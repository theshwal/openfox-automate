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
    /**
     * The host project the workflow belongs to.
     *
     * The supported HTTP launch path goes through the host's TASK BOARD
     * (`/api/projects/:projectId/tasks`), so the project is required there.
     */
    projectId?: string | undefined;
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
 *
 * The HTTP LAUNCH goes through the host's TASK BOARD, because that is the
 * only HTTP-reachable path where the host resolves a `/<workflow-id>`
 * prompt into a workflow run: `resolveSlashLaunch` has exactly one call
 * site in the host, the task path (`seedSession`). The session-message
 * route only queues the raw text as a chat message.
 */
export interface OpenFoxOrchestration {
    createSession(projectId: string, title: string): Promise<SessionLike>;
    stopSession(sessionId: string): Promise<void> | void;
    /**
     * Ask the host to launch a workflow.
     *
     * It returns the session the host actually bound to the run: the host
     * seeds a NEW session when the one it was given already has messages,
     * so the caller MUST follow the reported id — otherwise the host's
     * events are ignored and the chain stalls.
     */
    launchWorkflow(params: LaunchWorkflowParams): Promise<LaunchOutcome>;
}
export interface LaunchOutcome {
    /** The session the host bound to the run, when it reports one. */
    sessionId?: string | undefined;
    /**
     * Whether the workflow actually STARTED.
     *
     * It is false for two DIFFERENT reasons, and the caller must tell them
     * apart:
     *
     *   - 'refused': the plugin could not build a valid launch (the
     *     workflow's declared parameters could not be read, or a required
     *     one is missing). The host was never asked to run anything.
     *   - 'queued': the host accepted the task but its slot limit was
     *     reached, so the run waits for a slot.
     */
    launched: boolean;
    /** Why the launch did not start, when it did not. */
    failure?: 'refused' | 'queued' | undefined;
    /** The reason, in operator-readable words. */
    reason?: string | undefined;
    /**
     * The id of the host TASK the launch created. The host only frees its
     * worker slot when the task leaves "in_progress", so it must be closed
     * when the chain ends.
     */
    taskId?: string | undefined;
}
export interface OrchestrationDeps {
    createSession?: (projectId: string, title: string) => Promise<SessionLike>;
    stopSession?: (sessionId: string) => Promise<void> | void;
    launchWorkflow?: (params: LaunchWorkflowParams) => Promise<LaunchOutcome>;
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
/**
 * Read the host base URL from the plugin settings.
 *
 * The host does not expose its port to a plugin (`PluginRuntime` carries
 * only `mode` and `configDirectory`), so the URL is operator-supplied.
 * When it is absent, the host's own default is used — which is correct
 * for a local installation.
 */
export declare function readHostBaseUrl(context: PluginContext): string | null;
/** The session token, when the host requires network authentication. */
export declare function readHostToken(context: PluginContext): string | null;
export declare function createHostOrchestration(context: PluginContext, httpClientFactory?: HttpClientFactory): OpenFoxOrchestration;
export declare function createOrchestration(context: PluginContext, deps?: OrchestrationDeps): OpenFoxOrchestration;
//# sourceMappingURL=orchestration.d.ts.map