/**
 * Internal port/adapter for OpenFox orchestration.
 *
 * The state machine in the plugin talks only to this interface, which
 * keeps it testable and decoupled from the concrete shape of the
 * PluginContext API exposed by the host (openFoxInternals vs the future
 * `host` rename vs a mock for tests).
 */
import type { PluginContext } from 'openfox/plugin';
export interface SessionLike {
    id: string;
    workdir?: string;
}
export interface LaunchWorkflowParams {
    sessionId: string;
    workflowId: string;
    params?: Record<string, string>;
    content?: string;
    subGroup?: string;
}
/**
 * Internal contract used by the plugin's chain orchestrator. The host
 * implements this (in-process today via context.openFoxInternals, or via a
 * dedicated `host` API in the future). Tests inject a fake.
 */
export interface OpenFoxOrchestration {
    createSession(projectId: string, title: string): Promise<SessionLike>;
    stopSession(sessionId: string): Promise<void> | void;
    launchWorkflow(params: LaunchWorkflowParams): void;
}
export interface OrchestrationDeps {
    createSession?: (projectId: string, title: string) => Promise<SessionLike>;
    stopSession?: (sessionId: string) => Promise<void> | void;
    launchWorkflow?: (params: LaunchWorkflowParams) => void;
}
/**
 * Default implementation that bridges to `context.openFoxInternals`
 * (and falls back to dynamic import for older hosts).
 */
export declare function createHostOrchestration(context: PluginContext): OpenFoxOrchestration;
/**
 * Build an `OpenFoxOrchestration` from explicit deps (used by tests).
 * If a dep is missing, it falls back to the default implementation.
 */
export declare function createOrchestration(context: PluginContext, deps?: OrchestrationDeps): OpenFoxOrchestration;
//# sourceMappingURL=orchestration.d.ts.map