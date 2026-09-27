/**
 * Internal port/adapter for OpenFox orchestration.
 *
 * The state machine in the plugin talks only to this interface, which
 * keeps it testable and decoupled from the concrete shape of the
 * PluginContext API exposed by the host (openFoxInternals vs the future
 * `host` rename vs a mock for tests).
 */

import type { PluginContext } from 'openfox/plugin'
import { getOpenFoxInternals } from './resolve-openfox.js'

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
 * Internal contract used by the plugin's chain orchestrator. The host
 * implements this (in-process today via context.openFoxInternals, or via a
 * dedicated `host` API in the future). Tests inject a fake.
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

/**
 * Default implementation that bridges to `context.openFoxInternals`
 * (and falls back to dynamic import for older hosts).
 */
export function createHostOrchestration(context: PluginContext): OpenFoxOrchestration {
  return {
    async createSession(projectId: string, title: string) {
      const internals = await getOpenFoxInternals(context)
      if (!internals) {
        throw new Error('OpenFox internals are not available; cannot create session')
      }
      const sm = internals.sessionManager as {
        createSession: (p: string, t: string) => SessionLike | Promise<SessionLike>
      }
      const session = await sm.createSession(projectId, title)
      return session
    },
    async stopSession(sessionId: string) {
      const internals = await getOpenFoxInternals(context)
      if (!internals) return
      const sm = internals.sessionManager as {
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
      const internals = await getOpenFoxInternals(context)
      if (!internals) {
        context.logger.warn(
          'OpenFox internals are not available; cannot launch workflow',
          params as unknown as Record<string, unknown>,
        )
        return
      }
      const fn = internals.runWorkflow
      if (typeof fn !== 'function') {
        context.logger.warn('runWorkflow is not a function on openFoxInternals; cannot launch workflow')
        return
      }
      const payload = {
        ...(params.workflowId ? { workflowId: params.workflowId } : {}),
        ...(params.params ? { params: params.params } : {}),
        ...(params.content !== undefined ? { content: params.content } : {}),
        ...(params.subGroup ? { subGroup: params.subGroup } : {}),
      }
      ;(fn as unknown as (sessionId: string, payload: unknown) => void)(params.sessionId, payload)
    },
  }
}

/**
 * Build an `OpenFoxOrchestration` from explicit deps (used by tests).
 * If a dep is missing, it falls back to the default implementation.
 */
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
      host.launchWorkflow(params)
    },
  }
}
