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
export interface OpenFoxInternals {
    sessionManager: unknown;
    launchWorkflowRun: unknown;
    llmClient: unknown;
}
export declare function getOpenFoxInternals(): Promise<OpenFoxInternals | null>;
export declare function getResolveError(): string | null;
export declare function isOpenFoxInternalsAvailable(): boolean;
export declare function _resetForTesting(): void;
//# sourceMappingURL=resolve-openfox.d.ts.map