/**
 * OpenFox internals resolver.
 *
 * Locates the host OpenFox install via `import.meta.resolve('openfox')`,
 * derives the `dist/server/` path, and dynamically imports `sessionManager`
 * (and the workflow `launchWorkflowRun`) from the host. The result is cached
 * after first successful resolution.
 *
 * If the resolver fails (e.g. `openfox` peer dep not installed where the
 * plugin is loaded), the resolved `internals` is null and the error is
 * exposed via `getResolveError()` for the health() RPC.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
let cached = null;
async function resolveOpenFoxPath() {
    const resolveFn = import.meta.resolve;
    let resolved;
    if (typeof resolveFn === 'function') {
        resolved = await resolveFn.call(import.meta, 'openfox');
    }
    else {
        throw new Error('import.meta.resolve is not available in this runtime');
    }
    if (resolved.endsWith('package.json')) {
        return dirname(fileURLToPath(resolved));
    }
    return dirname(fileURLToPath(resolved));
}
export async function getOpenFoxInternals() {
    if (cached)
        return cached.internals;
    try {
        const openfoxRoot = await resolveOpenFoxPath();
        const pkg = JSON.parse(readFileSync(join(openfoxRoot, 'package.json'), 'utf-8'));
        void pkg;
        const distServer = join(openfoxRoot, 'dist', 'server');
        const distUrl = pathToFileURL(distServer + '/').href;
        const sessionMod = (await import(/* @vite-ignore */ new URL('./session/index.js', distUrl).href));
        const runnerMod = (await import(/* @vite-ignore */ new URL('./runner/launch.js', distUrl).href));
        const sessionManager = sessionMod.sessionManager ??
            sessionMod.default?.sessionManager;
        const launchWorkflowRun = runnerMod.launchWorkflowRun;
        if (!sessionManager || !launchWorkflowRun) {
            cached = {
                internals: null,
                error: `OpenFox modules found but missing expected exports at ${distServer}`,
            };
            return null;
        }
        cached = {
            internals: { sessionManager, launchWorkflowRun, llmClient: null },
            error: null,
        };
        return cached.internals;
    }
    catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        cached = { internals: null, error };
        return null;
    }
}
export function getResolveError() {
    return cached?.error ?? null;
}
export function isOpenFoxInternalsAvailable() {
    return cached?.internals != null;
}
export function _resetForTesting() {
    cached = null;
}
//# sourceMappingURL=resolve-openfox.js.map