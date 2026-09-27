/**
 * OpenFox internals resolver.
 *
 * Prefers the host-exposed `context.host` (Plugin API v2.1+, exposes
 * `sessions.create / sessions.stop / workflows.launch`). Falls back to the
 * older `context.openFoxInternals` shape for backward compatibility, then to
 * a dynamic import of the host's dist/server for hosts that don't expose
 * either.
 */
let cachedFallback;
async function tryDynamicImport() {
    if (cachedFallback !== undefined)
        return cachedFallback;
    try {
        const resolveFn = import.meta
            .resolve;
        if (typeof resolveFn !== 'function') {
            cachedFallback = null;
            return null;
        }
        const resolved = await resolveFn.call(import.meta, 'openfox');
        const { fileURLToPath, pathToFileURL } = await import('node:url');
        const { dirname, join } = await import('node:path');
        const openfoxRoot = resolved.endsWith('package.json')
            ? dirname(fileURLToPath(resolved))
            : dirname(fileURLToPath(resolved));
        const distUrl = pathToFileURL(join(openfoxRoot, 'dist', 'server') + '/').href;
        const sessionMod = (await import(/* @vite-ignore */ new URL('./session/index.js', distUrl).href));
        const runnerMod = (await import(/* @vite-ignore */ new URL('./runner/launch.js', distUrl).href));
        const sessionManager = sessionMod.sessionManager ??
            sessionMod.default?.sessionManager;
        const launchWorkflowRun = runnerMod.launchWorkflowRun;
        if (!sessionManager || !launchWorkflowRun) {
            cachedFallback = null;
            return null;
        }
        cachedFallback = {
            kind: 'legacy',
            legacy: {
                sessionManager: sessionManager,
                runWorkflow: (sessionId, payload) => {
                    const args = payload;
                    const runner = launchWorkflowRun;
                    runner({
                        sessionManager,
                        sessionId,
                        ...(args.workflowId ? { workflowId: args.workflowId } : {}),
                        ...(args.params ? { params: args.params } : {}),
                    }, payload);
                },
            },
        };
        return cachedFallback ?? null;
    }
    catch {
        cachedFallback = null;
        return null;
    }
}
/** Resolve the orchestration surface. */
export async function getHostInternal(context) {
    // Preferred: host exposes PluginHost facade via context.host
    const hostFacade = context?.host;
    if (hostFacade)
        return { kind: 'facade', facade: hostFacade };
    // Legacy: context.openFoxInternals
    const legacy = context
        ?.openFoxInternals;
    if (legacy)
        return { kind: 'legacy', legacy };
    // Last resort: dynamic import of the host's dist/server
    return await tryDynamicImport();
}
/** Convenience: create session + launch each chain step. */
export async function createSessionAndLaunch(context, entry, chain) {
    const internal = await getHostInternal(context);
    if (!internal)
        return null;
    if (internal.kind === 'facade') {
        const session = await internal.facade.sessions.create({ projectId: entry.repoKey, title: entry.title });
        for (const step of chain) {
            internal.facade.workflows.launch({ sessionId: session.sessionId, workflowId: step.workflowId });
        }
        return { sessionId: session.sessionId };
    }
    for (const step of chain) {
        internal.legacy.runWorkflow(/* sessionId will be set after create */ '', { workflowId: step.workflowId });
    }
    return null;
}
export function getResolveError() {
    return null;
}
export function _resetForTesting() {
    cachedFallback = undefined;
}
//# sourceMappingURL=resolve-openfox.js.map