/**
 * OpenFox host-surface resolver.
 *
 * Prefers the host-exposed `context.host` (which exposes
 * `sessions.create / sessions.stop / workflows.launch`), then the older
 * `context.openFoxInternals` shape for backward compatibility.
 *
 * There is NO dynamic import of the host's internals any more: the
 * published package does not expose them (`openfox` only exports
 * `createServer` / `createServerHandle`), so such an import could never
 * work, and it coupled the plugin to the server's module layout.
 *
 * When neither surface is available the resolver returns null and the
 * caller must use the supported HTTP client (`src/host-client.ts`).
 * Failing closed is deliberate: the plugin must not invent an API.
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