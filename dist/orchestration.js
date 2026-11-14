/**
 * Internal port/adapter for OpenFox orchestration.
 *
 * The state machine in the plugin talks only to this interface, which
 * keeps it testable and decoupled from the concrete shape of the
 * PluginContext API exposed by the host (the discriminated union in
 * resolve-openfox.js).
 */
import { getHostInternal } from './resolve-openfox.js';
import { HostClient, defaultHostBaseUrl } from './host-client.js';
import { mapDeclaredParameters } from './parameter-mapping.js';
export function defaultHttpClientFactory(context) {
    return () => {
        const configured = readHostBaseUrl(context);
        if (!configured)
            return null;
        const token = readHostToken(context);
        return new HostClient({
            baseUrl: configured,
            ...(token ? { token } : {}),
            timeoutMs: 10_000,
        });
    };
}
/**
 * Read the host base URL from the plugin settings.
 *
 * The host does not expose its port to a plugin (`PluginRuntime` carries
 * only `mode` and `configDirectory`), so the URL is operator-supplied.
 * When it is absent, the host's own default is used — which is correct
 * for a local installation.
 */
export function readHostBaseUrl(context) {
    const settings = (context.settings ? context.settings() : {});
    const configured = settings['host.baseUrl'];
    if (typeof configured === 'string' && configured.trim().length > 0)
        return configured.trim();
    return defaultHostBaseUrl(context.runtime.mode);
}
/** The session token, when the host requires network authentication. */
export function readHostToken(context) {
    const settings = (context.settings ? context.settings() : {});
    const token = settings['host.sessionToken'];
    return typeof token === 'string' && token.length > 0 ? token : null;
}
export function createHostOrchestration(context, httpClientFactory = defaultHttpClientFactory(context)) {
    return {
        async createSession(projectId, title) {
            const internal = await getHostInternal(context);
            if (internal?.kind === 'facade') {
                const s = await internal.facade.sessions.create({ projectId, title });
                return { id: s.sessionId, ...(s.workdir !== undefined ? { workdir: s.workdir } : {}) };
            }
            if (internal?.kind === 'legacy') {
                const s = await internal.legacy.sessionManager.createSession(projectId, title);
                return { id: s.id, ...(s.workdir !== undefined ? { workdir: s.workdir } : {}) };
            }
            // No in-process surface: the supported HTTP API.
            const client = httpClientFactory();
            if (!client) {
                throw new Error('OpenFox host orchestration is not available; cannot create session');
            }
            const result = await client.createSession(projectId, title);
            if (!result.ok) {
                throw new Error(`OpenFox host refused the session creation (${result.reason}): ${result.message}`);
            }
            return {
                id: result.value.id,
                ...(result.value.workdir !== undefined ? { workdir: result.value.workdir } : {}),
            };
        },
        async stopSession(sessionId) {
            const internal = await getHostInternal(context);
            if (internal?.kind === 'facade') {
                internal.facade.sessions.stop(sessionId);
                return;
            }
            if (internal?.kind === 'legacy') {
                const sm = internal.legacy.sessionManager;
                if (sm.stopSession) {
                    await sm.stopSession(sessionId);
                }
                else if (sm.setRunning) {
                    sm.setRunning(sessionId, false);
                }
                return;
            }
            const client = httpClientFactory();
            if (!client)
                return;
            const result = await client.stopSession(sessionId);
            if (!result.ok) {
                // The caller must KNOW: a session that could not be stopped may
                // still be running, and starting the issue again would create a
                // second live session for it.
                throw new Error(`stopSession failed (${result.reason}): ${result.message}`);
            }
        },
        async launchWorkflow(params) {
            const internal = await getHostInternal(context);
            if (internal?.kind === 'facade') {
                internal.facade.workflows.launch(params);
                return { sessionId: params.sessionId, launched: true };
            }
            if (internal?.kind === 'legacy') {
                internal.legacy.runWorkflow(params.sessionId, {
                    workflowId: params.workflowId,
                    ...(params.params ? { params: params.params } : {}),
                    ...(params.content !== undefined ? { content: params.content } : {}),
                    ...(params.subGroup ? { subGroup: params.subGroup } : {}),
                });
                return { sessionId: params.sessionId, launched: true };
            }
            // The supported HTTP API: the HOST resolves the workflow id and runs
            // it. The plugin never executes a workflow itself.
            const client = httpClientFactory();
            if (!client) {
                context.logger.warn('OpenFox host orchestration is not available; cannot launch workflow', params);
                return {
                    launched: false,
                    failure: 'refused',
                    reason: 'the host is not reachable: no base URL is configured',
                };
            }
            if (!params.projectId) {
                context.logger.warn('cannot launch workflow: the host project is unknown', {
                    workflowId: params.workflowId,
                });
                return {
                    launched: false,
                    failure: 'refused',
                    reason: 'the host project is unknown',
                };
            }
            // The host maps the positional arguments onto the workflow's
            // DECLARED parameters, by position, and refuses the launch when a
            // required one is missing — the prompt is then queued as a plain
            // chat message and the workflow never starts.
            //
            // The declared order is therefore READ FROM THE HOST, and the
            // values are mapped onto it. When the declaration cannot be read,
            // the launch is REFUSED: guessing the order from `Object.keys()`
            // is what put an issue URL in the `repo` parameter.
            const declared = await client.getWorkflowParameters(params.workflowId);
            const mapping = mapDeclaredParameters(declared.ok ? declared.value : null, params.params ?? {});
            if (!mapping.ok) {
                context.logger.warn(`cannot launch "${params.workflowId}": ${mapping.message}`, mapping.reason === 'missing-required' ? { missing: mapping.missing } : {});
                return { launched: false, failure: 'refused', reason: mapping.message };
            }
            const result = await client.launchWorkflow(params.projectId, params.workflowId, mapping.params, 
            // The values are ALREADY in the host's declared order: they are
            // sent as the positional arguments, and the host maps them onto
            // the same sorted list.
            mapping.values, 
            // The EXISTING session: the host reuses it when it is still
            // pristine. When it is not, the host seeds a new one and reports
            // it — the caller follows the reported id.
            params.sessionId);
            if (!result.ok) {
                context.logger.warn(`launchWorkflow failed (${result.reason}): ${result.message}`, {
                    workflowId: params.workflowId,
                });
                return { launched: false, failure: 'refused', reason: result.message };
            }
            return {
                sessionId: result.value.sessionId,
                launched: result.value.launched,
                // The host queued the task: its slot limit was reached.
                ...(result.value.launched
                    ? {}
                    : { failure: 'queued', reason: 'the host slot limit was reached' }),
                taskId: result.value.task.id,
            };
        },
    };
}
export function createOrchestration(context, deps = {}) {
    const host = createHostOrchestration(context);
    return {
        async createSession(projectId, title) {
            if (deps.createSession)
                return await deps.createSession(projectId, title);
            return await host.createSession(projectId, title);
        },
        async stopSession(sessionId) {
            if (deps.stopSession) {
                await deps.stopSession(sessionId);
                return;
            }
            await host.stopSession(sessionId);
        },
        async launchWorkflow(params) {
            if (deps.launchWorkflow) {
                return await deps.launchWorkflow(params);
            }
            return await host.launchWorkflow(params);
        },
    };
}
//# sourceMappingURL=orchestration.js.map