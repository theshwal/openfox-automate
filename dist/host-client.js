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
 *   GET  /api/sessions/:id                  -> session state
 *   POST /api/sessions/:id/stop             -> stop the session
 *   GET  /api/workflows                     -> available workflows
 *   POST /api/projects/:id/tasks            { prompt }            -> task board
 *   POST /api/projects/:id/tasks/:task/move { to }               -> task board
 *
 * A workflow is launched by submitting a TASK whose prompt starts with
 * `/<workflow-id>` and then moving that task to "in_progress": the host's
 * `resolveSlashLaunch` looks the id up in the user + project workflow
 * directories and launches it with the remaining tokens as parameters.
 * That is the host's own supported workflow-launch syntax, so the plugin
 * does not re-implement the runner.
 *
 * NOT the session-message route: `POST /api/sessions/:id/message` only
 * queues the raw text as a chat message — the queue processor then runs a
 * plain chat turn, so a `/<workflow-id>` prompt sent there is delivered
 * LITERALLY and never starts a workflow. `resolveSlashLaunch` has exactly
 * one call site in the host: the task path.
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
export function buildWorkflowLaunchMessage(workflowId, params = {}, orderedParamIds, content) {
    const ids = orderedParamIds && orderedParamIds.length > 0 ? orderedParamIds : Object.keys(params);
    const values = ids.map((id) => params[id]).filter((v) => typeof v === 'string' && v.length > 0);
    const head = [`/${workflowId}`, ...values].join(' ');
    // The host only ever sees `task.prompt`, so the issue CONTEXT is carried
    // after the positional arguments: the arguments come first because the
    // host maps them onto the declared parameters by position.
    if (!content || content.trim().length === 0)
        return head;
    return `${head}\n\n${content}`;
}
function failure(reason, message, status) {
    return status === undefined ? { ok: false, reason, message } : { ok: false, reason, message, status };
}
/**
 * Validate the operator-supplied host base URL.
 *
 * The OpenFox server listens on the loopback interface, so only a
 * loopback origin is accepted. This keeps a mistyped or tampered setting
 * from making the plugin send its session token to an arbitrary host, and
 * it rules out an SSRF through the base URL.
 */
export function validateHostBaseUrl(baseUrl) {
    let parsed;
    try {
        parsed = new URL(baseUrl);
    }
    catch {
        return { ok: false, message: 'OpenFox host base URL is not a valid URL' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, message: `unsupported scheme for the host base URL: ${parsed.protocol}` };
    }
    const host = parsed.hostname.toLowerCase();
    const isLoopback = host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '::1' ||
        host === '[::1]' ||
        host.endsWith('.localhost');
    if (!isLoopback) {
        return {
            ok: false,
            message: `the OpenFox host must be on the loopback interface, got "${parsed.hostname}"`,
        };
    }
    return { ok: true, origin: `${parsed.protocol}//${parsed.host}` };
}
/**
 * A thin, fail-closed client over the OpenFox local HTTP API.
 *
 * It is deliberately NOT constructed at import time: a plugin must opt in
 * (settings, or a test) before any request is attempted.
 */
export class HostClient {
    config;
    fetchImpl;
    constructor(config, deps = {}) {
        this.config = config;
        const impl = deps.fetchImpl ?? globalThis.fetch;
        if (!impl) {
            throw new Error('HostClient requires a fetch implementation');
        }
        this.fetchImpl = impl;
    }
    async request(method, path, body) {
        const base = this.config.baseUrl?.trim();
        if (!base) {
            return failure('not-configured', 'OpenFox host base URL is not configured');
        }
        // The base URL is operator-supplied, so it is validated before any
        // request: only a loopback HTTP(S) origin is accepted. Without this
        // check a mistyped (or tampered) setting would make the plugin send
        // the session token to an arbitrary host.
        const validation = validateHostBaseUrl(base);
        if (!validation.ok) {
            return failure('bad-request', validation.message);
        }
        const url = `${validation.origin}${path}`;
        const headers = { Accept: 'application/json' };
        if (body !== undefined)
            headers['Content-Type'] = 'application/json';
        if (this.config.token)
            headers['x-session-token'] = this.config.token;
        const timeoutMs = this.config.timeoutMs ?? 10_000;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await this.fetchImpl(url, {
                method,
                headers,
                ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
                signal: controller.signal,
            });
            if (res.status === 401 || res.status === 403) {
                return failure('unauthorized', `Host refused the request (${res.status})`, res.status);
            }
            if (res.status === 404) {
                return failure('not-found', `Host resource not found (${res.status})`, res.status);
            }
            if (res.status === 409) {
                return failure('conflict', `Host reported a conflict (${res.status})`, res.status);
            }
            if (res.status >= 400 && res.status < 500) {
                return failure('bad-request', `Host rejected the request (${res.status})`, res.status);
            }
            if (!res.ok) {
                return failure('server-error', `Host returned ${res.status}`, res.status);
            }
            const text = await res.text();
            if (!text)
                return { ok: true, value: undefined };
            try {
                return { ok: true, value: JSON.parse(text) };
            }
            catch {
                return failure('invalid-response', 'Host returned a non-JSON body');
            }
        }
        catch (err) {
            if (err instanceof Error && err.name === 'AbortError') {
                return failure('unreachable', `Host request timed out after ${timeoutMs}ms`);
            }
            return failure('unreachable', err instanceof Error ? err.message : String(err));
        }
        finally {
            clearTimeout(timer);
        }
    }
    /** `POST /api/sessions` — create a session bound to a host project. */
    async createSession(projectId, title) {
        if (!projectId) {
            return failure('bad-request', 'projectId is required to create a session');
        }
        const res = await this.request('POST', '/api/sessions', {
            projectId,
            ...(title ? { title } : {}),
        });
        if (!res.ok)
            return res;
        const session = res.value?.session;
        if (!session?.id) {
            return failure('invalid-response', 'Host did not return a session id');
        }
        return { ok: true, value: session };
    }
    /** `GET /api/sessions/:id` — read the session state. */
    async getSession(sessionId) {
        if (!sessionId)
            return failure('bad-request', 'sessionId is required');
        return await this.request('GET', `/api/sessions/${encodeURIComponent(sessionId)}`);
    }
    /**
     * Read the declared parameters of a workflow, ordered by position.
     *
     * The host maps the positional arguments of a `/<workflow-id> <args…>`
     * prompt onto the workflow's `parameters` BY POSITION, and refuses the
     * launch when a required parameter is missing. The plugin therefore has
     * to send the arguments in the DECLARED order — not in `Object.keys()`
     * order — or the workflow silently never starts.
     */
    async getWorkflowParameters(workflowId) {
        if (!workflowId)
            return failure('bad-request', 'workflowId is required');
        const res = await this.listWorkflows();
        if (!res.ok)
            return res;
        const workflow = res.value.find((w) => w.id === workflowId);
        if (!workflow) {
            return failure('not-found', `the host does not know the workflow "${workflowId}"`);
        }
        const parameters = [...(workflow.parameters ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
        return { ok: true, value: parameters };
    }
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
     *   task path (`seedSession`). The route
     *   `POST /api/sessions/:id/message` merely queues the raw text and the
     *   queue processor runs a plain chat turn, so a `/<workflow-id>`
     *   prompt sent there is delivered LITERALLY and never starts a
     *   workflow.
     *
     * THE SESSION: the host's `reusableTarget` only reuses a session that
     * has NO MESSAGES yet, so the host CANNOT continue a session that
     * already ran a workflow — it seeds a new one. The plugin therefore
     * follows the session the host REPORTS (the move response carries it)
     * instead of assuming its own session is reused. That is the only way
     * the chain can advance past its first step.
     *
     * The task is created in "To Do" and then MOVED to "in_progress": the
     * move is what triggers the host's auto-launch.
     */
    async launchWorkflow(projectId, workflowId, params = {}, orderedParamIds, sessionId, content) {
        if (!workflowId)
            return failure('bad-request', 'workflowId is required');
        if (!projectId)
            return failure('bad-request', 'projectId is required');
        // The issue CONTEXT must not be lost: the host only ever sees
        // `task.prompt`, so it is appended after the launch arguments. The
        // arguments stay first, because the host maps them positionally.
        const prompt = buildWorkflowLaunchMessage(workflowId, params, orderedParamIds, content);
        const created = await this.request('POST', `/api/projects/${encodeURIComponent(projectId)}/tasks`, { prompt });
        if (!created.ok)
            return created;
        const task = created.value?.task;
        if (!task?.id) {
            return failure('invalid-response', 'Host did not return a task id');
        }
        // Moving the task to "in_progress" is what makes the host launch it.
        //
        // The EXISTING session is passed so the host can reuse it when it is
        // still pristine (the first step of a chain). When it is not, the host
        // seeds a new session and REPORTS it — the caller must follow that id.
        const moved = await this.request('POST', `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}/move`, {
            to: 'in_progress',
            ...(sessionId ? { sessionId } : {}),
        });
        if (!moved.ok)
            return moved;
        return {
            ok: true,
            value: {
                task: moved.value?.task ?? task,
                // The session the host actually bound to the task.
                sessionId: moved.value?.sessionId ?? sessionId,
                // The host queues the task when its slot limit is reached: the
                // workflow has NOT started.
                launched: moved.value?.task?.runState !== 'queued',
            },
        };
    }
    /**
     * Close a task: the host only frees its worker slot when the task
     * leaves the "in_progress" state. A task left there consumes the slot
     * forever, so the next issue would never be launched.
     */
    async completeTask(projectId, taskId) {
        if (!taskId)
            return failure('bad-request', 'taskId is required');
        return await this.request('POST', `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/move`, { to: 'done' });
    }
    /** Delete a task (used when the issue fails or is cancelled). */
    async deleteTask(projectId, taskId) {
        if (!taskId)
            return failure('bad-request', 'taskId is required');
        return await this.request('DELETE', `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`);
    }
    /**
     * Raise the host's task slot limit.
     *
     * The host's default is ONE concurrent task per project, so the host's
     * own scheduler would serialise the plugin's five workers. The plugin
     * asks for the capacity it needs — the host clamps it to 1..10.
     */
    async setTaskSlotLimit(projectId, slotLimit) {
        if (!projectId)
            return failure('bad-request', 'projectId is required');
        const limit = Math.max(1, Math.min(10, Math.floor(slotLimit)));
        return await this.request('PUT', `/api/projects/${encodeURIComponent(projectId)}/tasks/settings`, { slotLimit: limit });
    }
    /** `POST /api/sessions/:id/stop` — stop a running session. */
    async stopSession(sessionId) {
        if (!sessionId)
            return failure('bad-request', 'sessionId is required');
        return await this.request('POST', `/api/sessions/${encodeURIComponent(sessionId)}/stop`, {});
    }
    /** `GET /api/workflows` — list the workflows the host can run. */
    async listWorkflows() {
        const res = await this.request('GET', '/api/workflows');
        if (!res.ok)
            return res;
        const value = res.value;
        return {
            ok: true,
            value: [...(value?.defaults ?? []), ...(value?.userItems ?? []), ...(value?.projectItems ?? [])],
        };
    }
}
/**
 * Resolve the host's local API base URL from the plugin runtime.
 *
 * The plugin runtime exposes `mode` and `configDirectory` only. The port
 * is a host configuration value, so it is read from the host's global
 * config file when present. This never contacts the server: it only reads
 * a configuration file.
 */
export function defaultHostBaseUrl(mode) {
    // Mirrors the host's own default (chunk-D67RLN3F.js: `server.port`).
    return mode === 'development' ? 'http://127.0.0.1:10469' : 'http://127.0.0.1:10369';
}
//# sourceMappingURL=host-client.js.map