/**
 * Internal port/adapter for OpenFox orchestration.
 *
 * The state machine in the plugin talks only to this interface, which
 * keeps it testable and decoupled from the concrete shape of the
 * PluginContext API exposed by the host (openFoxInternals vs the future
 * `host` rename vs a mock for tests).
 */
import { getOpenFoxInternals } from './resolve-openfox.js';
/**
 * Default implementation that bridges to `context.openFoxInternals`
 * (and falls back to dynamic import for older hosts).
 */
export function createHostOrchestration(context) {
    return {
        async createSession(projectId, title) {
            const internals = await getOpenFoxInternals(context);
            if (!internals) {
                throw new Error('OpenFox internals are not available; cannot create session');
            }
            const sm = internals.sessionManager;
            const session = await sm.createSession(projectId, title);
            return session;
        },
        async stopSession(sessionId) {
            const internals = await getOpenFoxInternals(context);
            if (!internals)
                return;
            const sm = internals.sessionManager;
            if (sm.stopSession) {
                await sm.stopSession(sessionId);
            }
            else if (sm.setRunning) {
                sm.setRunning(sessionId, false);
            }
        },
        async launchWorkflow(params) {
            const internals = await getOpenFoxInternals(context);
            if (!internals) {
                context.logger.warn('OpenFox internals are not available; cannot launch workflow', params);
                return;
            }
            const fn = internals.runWorkflow;
            if (typeof fn !== 'function') {
                context.logger.warn('runWorkflow is not a function on openFoxInternals; cannot launch workflow');
                return;
            }
            const payload = {
                ...(params.workflowId ? { workflowId: params.workflowId } : {}),
                ...(params.params ? { params: params.params } : {}),
                ...(params.content !== undefined ? { content: params.content } : {}),
                ...(params.subGroup ? { subGroup: params.subGroup } : {}),
            };
            fn(params.sessionId, payload);
        },
    };
}
/**
 * Build an `OpenFoxOrchestration` from explicit deps (used by tests).
 * If a dep is missing, it falls back to the default implementation.
 */
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
            host.launchWorkflow(params);
        },
    };
}
//# sourceMappingURL=orchestration.js.map