/**
 * OpenFox internals resolver.
 *
 * Prefers the host-exposed `context.host` (Plugin API v2.1+, exposes
 * `sessions.create / sessions.stop / workflows.launch`). Falls back to the
 * older `context.openFoxInternals` shape for backward compatibility, then to
 * a dynamic import of the host's dist/server for hosts that don't expose
 * either.
 */
/**
 * The dynamic-import fallback has been REMOVED.
 *
 * It resolved `openfox` and imported `dist/server/session/index.js` and
 * `dist/server/runner/launch.js` — paths that do not exist in the
 * published package (`openfox` only exports `createServer` /
 * `createServerHandle`), so the fallback could never work. It also
 * coupled the plugin to the host's internal module layout, which is not
 * part of the package's `exports` map and moves between releases.
 *
 * The supported replacement is `src/host-client.ts`, which uses the
 * host's documented local HTTP API.
 */
/** Resolve the orchestration surface. */
export async function getHostInternal(context) {
    // Preferred: host exposes PluginHost facade via context.host
    const hostFacade = context?.host;
    if (hostFacade)
        return { kind: 'facade', facade: hostFacade };
    // Legacy: context.openFoxInternals (kept for hosts that expose it)
    const legacy = context
        ?.openFoxInternals;
    if (legacy)
        return { kind: 'legacy', legacy };
    // No in-process surface: the caller must use the supported HTTP client
    // (`src/host-client.ts`). Returning null here is FAIL CLOSED — the
    // plugin must not invent an API or import the host's internals.
    return null;
}
export function getResolveError() {
    return null;
}
export function _resetForTesting() {
    // Nothing is cached any more: the resolver is a pure lookup.
}
//# sourceMappingURL=resolve-openfox.js.map