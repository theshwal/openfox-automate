/**
 * Internal port/adapter for OpenFox orchestration.
 *
 * The state machine in the plugin talks only to this interface, which
 * keeps it testable and decoupled from the concrete shape of the
 * PluginContext API exposed by the host (the discriminated union in
 * resolve-openfox.js).
 */

import type { PluginContext } from 'openfox/plugin'
import { getHostInternal } from './resolve-openfox.js'

export interface SessionLike {
  id: string
  workdir?: string
}

export interface LaunchWorkflowParams {
  sessionId: string
  workflowId: string
  params?: Record<string, string>
  content?: string
  subGroup?: string
}

/**
 * Default implementation that bridges to whichever host surface is exposed
 * (`context.host` on Plugin API v2.1+, or legacy `context.openFoxInternals`
 * on older hosts). Tests inject a fake via deps.
 */
export interface OpenFoxOrchestration {
  createSession(projectId: string, title: string): Promise<SessionLike>
  stopSession(sessionId: string): Promise<void> | void
  launchWorkflow(params: LaunchWorkflowParams): void
}

export interface OrchestrationDeps {
  createSession?: (projectId: string, title: string) => Promise<SessionLike>
  stopSession?: (sessionId: string) => Promise<void> | void
  launchWorkflow?: (params: LaunchWorkflowParams) => void
}

export function createHostOrchestration(context: PluginContext): OpenFoxOrchestration {
  return {
    async createSession(projectId: string, title: string) {
      const internal = await getHostInternal(context)
      if (!internal) {
        throw new Error('OpenFox host orchestration is not available; cannot create session')
      }
      if (internal.kind === 'facade') {
        const s = await internal.facade.sessions.create({ projectId, title })
        return { id: s.sessionId, ...(s.workdir !== undefined ? { workdir: s.workdir } : {}) }
      }
      const s = await internal.legacy.sessionManager.createSession(projectId, title)
      return { id: s.id, ...(s.workdir !== undefined ? { workdir: s.workdir } : {}) }
    },
    async stopSession(sessionId: string) {
      const internal = await getHostInternal(context)
      if (!internal) return
      if (internal.kind === 'facade') {
        internal.facade.sessions.stop(sessionId)
        return
      }
      const sm = internal.legacy.sessionManager as {
        stopSession?: (id: string) => Promise<void> | void
        setRunning?: (id: string, running: boolean) => void
      }
      if (sm.stopSession) {
        await sm.stopSession(sessionId)
      } else if (sm.setRunning) {
        sm.setRunning(sessionId, false)
      }
    },
    async launchWorkflow(params: LaunchWorkflowParams) {
      const internal = await getHostInternal(context)
      if (!internal) {
        context.logger.warn(
          'OpenFox host orchestration is not available; cannot launch workflow',
          params as unknown as Record<string, unknown>,
        )
        return
      }
      if (internal.kind === 'facade') {
        internal.facade.workflows.launch(params)
        return
      }
      internal.legacy.runWorkflow(params.sessionId, {
        workflowId: params.workflowId,
        ...(params.params ? { params: params.params } : {}),
        ...(params.content !== undefined ? { content: params.content } : {}),
        ...(params.subGroup ? { subGroup: params.subGroup } : {}),
      })
    },
  }
}

export function createOrchestration(
  context: PluginContext,
  deps: OrchestrationDeps = {},
): OpenFoxOrchestration {
  const host = createHostOrchestration(context)
  return {
    async createSession(projectId, title) {
      if (deps.createSession) return await deps.createSession(projectId, title)
      return await host.createSession(projectId, title)
    },
    async stopSession(sessionId) {
      if (deps.stopSession) {
        await deps.stopSession(sessionId)
        return
      }
      await host.stopSession(sessionId)
    },
    launchWorkflow(params) {
      if (deps.launchWorkflow) {
        deps.launchWorkflow(params)
        return
      }
      void host.launchWorkflow(params)
    },
  }
}
