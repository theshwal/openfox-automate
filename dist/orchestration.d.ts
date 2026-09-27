/**
 * Internal port/adapter for OpenFox orchestration.
 *
 * The state machine in the plugin talks only to this interface, which
 * keeps it testable and decoupled from the concrete shape of the
 * PluginContext API exposed by the host (the discriminated union in
 * resolve-openfox.js).
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
 * Default implementation that bridges to whichever host surface is exposed
 * (`context.host` on Plugin API v2.1+, or legacy `context.openFoxInternals`
 * on older hosts). Tests inject a fake via deps.
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
export declare function createHostOrchestration(context: PluginContext): OpenFoxOrchestration;
export declare function createOrchestration(context: PluginContext, deps?: OrchestrationDeps): OpenFoxOrchestration;
//# sourceMappingURL=orchestration.d.ts.map