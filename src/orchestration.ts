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
import { HostClient, defaultHostBaseUrl } from './host-client.js'

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
  /**
   * The host project the workflow belongs to.
   *
   * The supported HTTP launch path goes through the host's TASK BOARD
   * (`/api/projects/:projectId/tasks`), so the project is required there.
   */
  projectId?: string | undefined
}

/**
 * Default implementation that bridges to whichever host surface is exposed.
 *
 * The order is deliberate:
 *
 *   1. `context.host` — an in-process facade, when the host provides one;
 *   2. `context.openFoxInternals` — the legacy in-process surface;
 *   3. the SUPPORTED HTTP API (`src/host-client.ts`).
 *
 * The third path matters: OpenFox 2.0.160 and 2.0.161 expose NEITHER
 * in-process surface to a plugin (`PluginContext` declares no `host` and no
 * `openFoxInternals`, and the package does not export `sessionManager` nor
 * `launchWorkflowRun`), so without the HTTP path the plugin could not
 * create a session at all on a real host. The HTTP path is fail-closed:
 * it only runs when a base URL is configured, and every failure is
 * reported as a typed error.
 *
 * The HTTP LAUNCH goes through the host's TASK BOARD, because that is the
 * only HTTP-reachable path where the host resolves a `/<workflow-id>`
 * prompt into a workflow run: `resolveSlashLaunch` has exactly one call
 * site in the host, the task path (`seedSession`). The session-message
 * route only queues the raw text as a chat message.
 */
export interface OpenFoxOrchestration {
  createSession(projectId: string, title: string): Promise<SessionLike>
  stopSession(sessionId: string): Promise<void> | void
  /**
   * Ask the host to launch a workflow.
   *
   * It returns the session the host actually bound to the run: the host
   * seeds a NEW session when the one it was given already has messages,
   * so the caller MUST follow the reported id — otherwise the host's
   * events are ignored and the chain stalls.
   */
  launchWorkflow(params: LaunchWorkflowParams): Promise<LaunchOutcome>
}

export interface LaunchOutcome {
  /** The session the host bound to the run, when it reports one. */
  sessionId?: string | undefined
  /** False when the host queued the run (its slot limit was reached). */
  launched: boolean
  /**
   * The id of the host TASK the launch created. The host only frees its
   * worker slot when the task leaves "in_progress", so it must be closed
   * when the chain ends.
   */
  taskId?: string | undefined
}

export interface OrchestrationDeps {
  createSession?: (projectId: string, title: string) => Promise<SessionLike>
  stopSession?: (sessionId: string) => Promise<void> | void
  launchWorkflow?: (params: LaunchWorkflowParams) => Promise<LaunchOutcome>
}

/**
 * The HTTP client used when no in-process surface is available.
 *
 * It is created lazily and only when the plugin was configured with a
 * host base URL: an unconfigured plugin never performs a request.
 */
export interface HttpClientFactory {
  (): HostClient | null
}

export function defaultHttpClientFactory(context: PluginContext): HttpClientFactory {
  return () => {
    const configured = readHostBaseUrl(context)
    if (!configured) return null
    const token = readHostToken(context)
    return new HostClient({
      baseUrl: configured,
      ...(token ? { token } : {}),
      timeoutMs: 10_000,
    })
  }
}

/**
 * Read the host base URL from the plugin settings.
 *
 * The host does not expose its port to a plugin (`PluginRuntime` carries
 * only `mode` and `configDirectory`), so the URL is operator-supplied.
 * When it is absent, the host's own default is used — which is correct
 * for a local installation.
 */
export function readHostBaseUrl(context: PluginContext): string | null {
  const settings = (context.settings ? context.settings() : {}) as Record<string, unknown>
  const configured = settings['host.baseUrl']
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim()
  return defaultHostBaseUrl(context.runtime.mode)
}

/** The session token, when the host requires network authentication. */
export function readHostToken(context: PluginContext): string | null {
  const settings = (context.settings ? context.settings() : {}) as Record<string, unknown>
  const token = settings['host.sessionToken']
  return typeof token === 'string' && token.length > 0 ? token : null
}

export function createHostOrchestration(
  context: PluginContext,
  httpClientFactory: HttpClientFactory = defaultHttpClientFactory(context),
): OpenFoxOrchestration {
  return {
    async createSession(projectId: string, title: string) {
      const internal = await getHostInternal(context)
      if (internal?.kind === 'facade') {
        const s = await internal.facade.sessions.create({ projectId, title })
        return { id: s.sessionId, ...(s.workdir !== undefined ? { workdir: s.workdir } : {}) }
      }
      if (internal?.kind === 'legacy') {
        const s = await internal.legacy.sessionManager.createSession(projectId, title)
        return { id: s.id, ...(s.workdir !== undefined ? { workdir: s.workdir } : {}) }
      }
      // No in-process surface: the supported HTTP API.
      const client = httpClientFactory()
      if (!client) {
        throw new Error('OpenFox host orchestration is not available; cannot create session')
      }
      const result = await client.createSession(projectId, title)
      if (!result.ok) {
        throw new Error(`OpenFox host refused the session creation (${result.reason}): ${result.message}`)
      }
      return {
        id: result.value.id,
        ...(result.value.workdir !== undefined ? { workdir: result.value.workdir } : {}),
      }
    },
    async stopSession(sessionId: string) {
      const internal = await getHostInternal(context)
      if (internal?.kind === 'facade') {
        internal.facade.sessions.stop(sessionId)
        return
      }
      if (internal?.kind === 'legacy') {
        const sm = internal.legacy.sessionManager as {
          stopSession?: (id: string) => Promise<void> | void
          setRunning?: (id: string, running: boolean) => void
        }
        if (sm.stopSession) {
          await sm.stopSession(sessionId)
        } else if (sm.setRunning) {
          sm.setRunning(sessionId, false)
        }
        return
      }
      const client = httpClientFactory()
      if (!client) return
      const result = await client.stopSession(sessionId)
      if (!result.ok) {
        // The caller must KNOW: a session that could not be stopped may
        // still be running, and starting the issue again would create a
        // second live session for it.
        throw new Error(`stopSession failed (${result.reason}): ${result.message}`)
      }
    },
    async launchWorkflow(params: LaunchWorkflowParams): Promise<LaunchOutcome> {
      const internal = await getHostInternal(context)
      if (internal?.kind === 'facade') {
        internal.facade.workflows.launch(params)
        return { sessionId: params.sessionId, launched: true }
      }
      if (internal?.kind === 'legacy') {
        internal.legacy.runWorkflow(params.sessionId, {
          workflowId: params.workflowId,
          ...(params.params ? { params: params.params } : {}),
          ...(params.content !== undefined ? { content: params.content } : {}),
          ...(params.subGroup ? { subGroup: params.subGroup } : {}),
        })
        return { sessionId: params.sessionId, launched: true }
      }
      // The supported HTTP API: the HOST resolves the workflow id and runs
      // it. The plugin never executes a workflow itself.
      const client = httpClientFactory()
      if (!client) {
        context.logger.warn(
          'OpenFox host orchestration is not available; cannot launch workflow',
          params as unknown as Record<string, unknown>,
        )
        return { launched: false }
      }
      if (!params.projectId) {
        context.logger.warn('cannot launch workflow: the host project is unknown', {
          workflowId: params.workflowId,
        })
        return { launched: false }
      }
      // The host maps the positional arguments onto the workflow's
      // DECLARED parameters, by position, and refuses the launch when a
      // required one is missing — the prompt is then queued as a plain chat
      // message and the workflow never starts. The declared order is
      // therefore read from the host before the prompt is built.
      const declared = await client.getWorkflowParameters(params.workflowId)
      const orderedParamIds = declared.ok ? declared.value.map((p) => p.id) : undefined
      if (!declared.ok) {
        context.logger.warn(`cannot map the parameters of "${params.workflowId}": ${declared.message}`)
      }
      const result = await client.launchWorkflow(
        params.projectId,
        params.workflowId,
        params.params ?? {},
        orderedParamIds,
        // The EXISTING session: the host reuses it when it is still
        // pristine. When it is not, the host seeds a new one and reports
        // it — the caller follows the reported id.
        params.sessionId,
        // The issue context: the host only sees `task.prompt`, so it would
        // otherwise be LOST.
        params.content,
      )
      if (!result.ok) {
        context.logger.warn(`launchWorkflow failed (${result.reason}): ${result.message}`, {
          workflowId: params.workflowId,
        })
        return { launched: false }
      }
      return {
        sessionId: result.value.sessionId,
        launched: result.value.launched,
        taskId: result.value.task.id,
      }
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
    async launchWorkflow(params) {
      if (deps.launchWorkflow) {
        return await deps.launchWorkflow(params)
      }
      return await host.launchWorkflow(params)
    },
  }
}
