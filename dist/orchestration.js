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
function readHostBaseUrl(context) {
    const settings = (context.settings ? context.settings() : {});
    const configured = settings['host.baseUrl'];
    if (typeof configured === 'string' && configured.trim().length > 0)
        return configured.trim();
    return defaultHostBaseUrl(context.runtime.mode);
}
/** The session token, when the host requires network authentication. */
function readHostToken(context) {
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
                context.logger.warn(`stopSession failed (${result.reason}): ${result.message}`);
            }
        },
        async launchWorkflow(params) {
            const internal = await getHostInternal(context);
            if (internal?.kind === 'facade') {
                internal.facade.workflows.launch(params);
                return;
            }
            if (internal?.kind === 'legacy') {
                internal.legacy.runWorkflow(params.sessionId, {
                    workflowId: params.workflowId,
                    ...(params.params ? { params: params.params } : {}),
                    ...(params.content !== undefined ? { content: params.content } : {}),
                    ...(params.subGroup ? { subGroup: params.subGroup } : {}),
                });
                return;
            }
            // The supported HTTP API: the HOST resolves the workflow id and runs
            // it. The plugin never executes a workflow itself.
            const client = httpClientFactory();
            if (!client) {
                context.logger.warn('OpenFox host orchestration is not available; cannot launch workflow', params);
                return;
            }
            const result = await client.launchWorkflow(params.sessionId, params.workflowId, params.params ?? {});
            if (!result.ok) {
                context.logger.warn(`launchWorkflow failed (${result.reason}): ${result.message}`, {
                    workflowId: params.workflowId,
                });
            }
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
        launchWorkflow(params) {
            if (deps.launchWorkflow) {
                deps.launchWorkflow(params);
                return;
            }
            void host.launchWorkflow(params);
        },
    };
}
//# sourceMappingURL=orchestration.js.map