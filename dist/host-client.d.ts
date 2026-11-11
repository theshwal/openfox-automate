/**
 * Host client — the supported way for the plugin to reach the OpenFox host.
 *
 * WHY THIS MODULE EXISTS
 *
 * OpenFox v2.0.160 / v2.0.161 do NOT expose a session or workflow API to
 * plugins:
 *
 *   - `PluginContext` (dist/plugin/index.d.ts) declares only:
 *     `id`, `version`, `runtime`, `logger`, `storage`, `settings()`,
 *     `notify()`, `publish()`. There is NO `host` and NO `openFoxInternals`.
 *   - The host builds the plugin context in
 *     `PluginHost.createContext` and returns exactly that object — no
 *     extra properties are attached at runtime.
 *   - The package's public entry points (`openfox`, `openfox/shared`,
 *     `openfox/plugin`) do NOT export `sessionManager`, `launchWorkflowRun`
 *     or any orchestrator. `openfox` only exports `createServer` /
 *     `createServerHandle`.
 *
 * The host DOES expose a documented local HTTP API, which is the only
 * supported channel for a plugin to create a session and drive a
 * workflow:
 *
 *   POST /api/sessions                      { projectId, title }  -> { session }
 *   POST /api/sessions/:id/message          { content }           -> queued message
 *   GET  /api/sessions/:id                  -> session state
 *   POST /api/sessions/:id/stop             -> stop the session
 *   GET  /api/workflows                     -> available workflows
 *
 * A queued message whose content starts with `/<workflow-id>` is resolved
 * by the host itself: `resolveSlashLaunch` looks the id up in the user +
 * project workflow directories and launches it with the remaining tokens as
 * parameters. That is the host's own supported workflow-launch syntax, so
 * the plugin does not re-implement the runner.
 *
 * DESIGN RULES
 *
 *   - FAIL CLOSED. Every entry point returns a typed failure instead of
 *     throwing, and the caller decides what to do. A plugin that cannot
 *     reach the host must NOT pretend it spawned a session.
 *   - NO INTERNALS. Nothing here imports from the host's internal module
 *     layout (`dist/server/session`, `dist/server/runner`, …). Those paths
 *     are not part of the package's `exports` map and moved between
 *     releases (the previous fallback in `resolve-openfox.ts` pointed at
 *     `dist/server/dist/server/session/index.js`, which does not exist).
 *   - NO NETWORK BY DEFAULT. The client is inert until a base URL and a
 *     token are configured, so unit tests and dry runs never touch a
 *     server.
 */
export type HostClientFailureReason = 'not-configured' | 'unreachable' | 'unauthorized' | 'not-found' | 'conflict' | 'bad-request' | 'server-error' | 'invalid-response';
export interface HostClientFailure {
    ok: false;
    reason: HostClientFailureReason;
    message: string;
    status?: number;
}
export interface HostClientSuccess<T> {
    ok: true;
    value: T;
}
export type HostClientResult<T> = HostClientSuccess<T> | HostClientFailure;
export interface HostClientConfig {
    /** Base URL of the OpenFox server, e.g. `http://127.0.0.1:10369`. */
    baseUrl: string;
    /** Session token, when the host requires network authentication. */
    token?: string | undefined;
    /** Per-request timeout in milliseconds. */
    timeoutMs?: number | undefined;
}
export interface HostSession {
    id: string;
    title?: string;
    projectId?: string;
    /** The host returns the session's working directory. */
    workdir?: string;
}
export interface HostWorkflowInfo {
    id: string;
    name?: string;
    description?: string;
}
/** A task of the host's project task board. */
export interface HostTask {
    id: string;
    status?: string;
    runState?: string;
    prompt?: string;
    sessionId?: string;
}
export interface HostClientDeps {
    /** Injection point for tests; defaults to the global `fetch`. */
    fetchImpl?: typeof fetch | undefined;
}
/**
 * Build the launch prompt understood by the host's workflow resolver.
 *
 * The host parses `/<id> <arg> <arg> …` and maps the positional arguments
 * onto the workflow's declared parameters (sorted by `position`). We
 * therefore pass the parameters in that declared order.
 *
 * IMPORTANT — where this prompt is valid:
 *
 *   The resolver (`resolveSlashLaunch`) has exactly ONE call site in the
 *   host: the TASK path (`seedSession`, chunk-Q54OOZ5U.js:1234). The
 *   session-message route (`POST /api/sessions/:id/message`) only queues
 *   the raw text as a user message; the queue processor runs a plain chat
 *   turn. A `/<workflow-id>` prompt sent there is delivered LITERALLY and
 *   never starts a workflow.
 *
 *   So this prompt must be sent to the task board
 *   (`POST /api/projects/:projectId/tasks`), which is the only
 *   HTTP-reachable path that makes the host resolve and launch a
 *   workflow.
 */
export declare function buildWorkflowLaunchMessage(workflowId: string, params?: Record<string, string>, orderedParamIds?: string[]): string;
/**
 * Validate the operator-supplied host base URL.
 *
 * The OpenFox server listens on the loopback interface, so only a
 * loopback origin is accepted. This keeps a mistyped or tampered setting
 * from making the plugin send its session token to an arbitrary host, and
 * it rules out an SSRF through the base URL.
 */
export declare function validateHostBaseUrl(baseUrl: string): {
    ok: true;
    origin: string;
} | {
    ok: false;
    message: string;
};
/**
 * A thin, fail-closed client over the OpenFox local HTTP API.
 *
 * It is deliberately NOT constructed at import time: a plugin must opt in
 * (settings, or a test) before any request is attempted.
 */
export declare class HostClient {
    private readonly config;
    private readonly fetchImpl;
    constructor(config: HostClientConfig, deps?: HostClientDeps);
    private request;
    /** `POST /api/sessions` — create a session bound to a host project. */
    createSession(projectId: string, title?: string): Promise<HostClientResult<HostSession>>;
    /** `GET /api/sessions/:id` — read the session state. */
    getSession(sessionId: string): Promise<HostClientResult<HostSession>>;
    /**
     * `POST /api/sessions/:id/message` — queue a message.
     *
     * A message starting with `/<workflow-id>` is resolved and launched by
     * the host as a workflow run.
     */
    sendMessage(sessionId: string, content: string): Promise<HostClientResult<unknown>>;
    /**
     * Launch a workflow through the host's TASK BOARD.
     *
     * The host owns the execution: `resolveSlashLaunch` resolves the
     * workflow id, validates the required parameters and runs the workflow.
     * The plugin only submits the task.
     *
     * WHY THE TASK BOARD AND NOT THE SESSION MESSAGE ROUTE:
     *
     *   `resolveSlashLaunch` has exactly one call site in the host — the
     *   task path (`seedSession`, chunk-Q54OOZ5U.js:1234). The route
     *   `POST /api/sessions/:id/message` merely queues the raw text and the
     *   queue processor runs a plain chat turn, so a `/<workflow-id>`
     *   prompt sent there is delivered LITERALLY and never starts a
     *   workflow.
     *
     *   The task board is the only HTTP-reachable path that makes the host
     *   resolve and launch a workflow. It also brings the host's own slot
     *   limit and task links, which is exactly what a scheduler wants.
     *
     * The task is created in "To Do" and then MOVED to "in_progress": the
     * move is what triggers the host's auto-launch.
     */
    launchWorkflow(projectId: string, workflowId: string, params?: Record<string, string>, orderedParamIds?: string[], sessionId?: string): Promise<HostClientResult<HostTask>>;
    /** `POST /api/sessions/:id/stop` — stop a running session. */
    stopSession(sessionId: string): Promise<HostClientResult<unknown>>;
    /** `GET /api/workflows` — list the workflows the host can run. */
    listWorkflows(): Promise<HostClientResult<HostWorkflowInfo[]>>;
}
/**
 * Resolve the host's local API base URL from the plugin runtime.
 *
 * The plugin runtime exposes `mode` and `configDirectory` only. The port
 * is a host configuration value, so it is read from the host's global
 * config file when present. This never contacts the server: it only reads
 * a configuration file.
 */
export declare function defaultHostBaseUrl(mode: 'production' | 'development'): string;
//# sourceMappingURL=host-client.d.ts.map