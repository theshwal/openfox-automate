/**
 * OpenFox internals resolver.
 *
 * Prefers the host-exposed `context.openFoxInternals` (apiVersion 2,
 * added by the host when it wires sessionManager + runWorkflow into
 * the plugin context). Falls back to a dynamic import of the host's
 * dist/server for older hosts that don't expose internals yet.
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
            sessionManager: sessionManager,
            runWorkflow: ((sessionId, payload) => {
                const args = payload;
                launchWorkflowRun({
                    sessionManager,
                    sessionId,
                    ...(args.workflowId ? { workflowId: args.workflowId } : {}),
                    ...(args.params ? { params: args.params } : {}),
                }, payload);
            }),
        };
        return cachedFallback;
    }
    catch {
        cachedFallback = null;
        return null;
    }
}
export async function getOpenFoxInternals(context) {
    // Host may expose openFoxInternals even when its npm type doesn't (e.g. local
    // dev install ahead of publish). Access it loosely and trust the host.
    const fromContext = context?.openFoxInternals;
    if (fromContext) {
        return fromContext;
    }
    return await tryDynamicImport();
}
export function getOpenFoxInternalsSync(context) {
    return context?.openFoxInternals ?? null;
}
export function getResolveError() {
    return null;
}
export function isOpenFoxInternalsAvailable() {
    return true;
}
export function _resetForTesting() {
    cachedFallback = undefined;
}
//# sourceMappingURL=resolve-openfox.js.map