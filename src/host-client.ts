/**
 * Host client — the supported way for the plugin to reach the OpenFox host.
 *
 * WHY THIS MODULE EXISTS
 *
 * OpenFox v2.0.160 / v2.0.161 do NOT expose a session or workflow API to
 * plugins:
 *
 *   - `PluginContext` (dist/plugin/index.d.ts) declares only:
 *     `id`, `version`, `runtime`, `logger`, `storage`, `settings()`,
 *     `notify()`, `publish()`. There is NO `host` and NO `openFoxInternals`.
 *   - The host builds the plugin context in
 *     `PluginHost.createContext` and returns exactly that object — no
 *     extra properties are attached at runtime.
 *   - The package's public entry points (`openfox`, `openfox/shared`,
 *     `openfox/plugin`) do NOT export `sessionManager`, `launchWorkflowRun`
 *     or any orchestrator. `openfox` only exports `createServer` /
 *     `createServerHandle`.
 *
 * The host DOES expose a documented local HTTP API, which is the only
 * supported channel for a plugin to create a session and drive a
 * workflow:
 *
 *   POST /api/sessions                      { projectId, title }  -> { session }
 *   POST /api/sessions/:id/message          { content }           -> queued message
 *   GET  /api/sessions/:id                  -> session state
 *   POST /api/sessions/:id/stop             -> stop the session
 *   GET  /api/workflows                     -> available workflows
 *
 * A queued message whose content starts with `/<workflow-id>` is resolved
 * by the host itself: `resolveSlashLaunch` looks the id up in the user +
 * project workflow directories and launches it with the remaining tokens as
 * parameters. That is the host's own supported workflow-launch syntax, so
 * the plugin does not re-implement the runner.
 *
 * DESIGN RULES
 *
 *   - FAIL CLOSED. Every entry point returns a typed failure instead of
 *     throwing, and the caller decides what to do. A plugin that cannot
 *     reach the host must NOT pretend it spawned a session.
 *   - NO INTERNALS. Nothing here imports from the host's internal module
 *     layout (`dist/server/session`, `dist/server/runner`, …). Those paths
 *     are not part of the package's `exports` map and moved between
 *     releases (the previous fallback in `resolve-openfox.ts` pointed at
 *     `dist/server/dist/server/session/index.js`, which does not exist).
 *   - NO NETWORK BY DEFAULT. The client is inert until a base URL and a
 *     token are configured, so unit tests and dry runs never touch a
 *     server.
 */

export type HostClientFailureReason =
  | 'not-configured'
  | 'unreachable'
  | 'unauthorized'
  | 'not-found'
  | 'conflict'
  | 'bad-request'
  | 'server-error'
  | 'invalid-response'

export interface HostClientFailure {
  ok: false
  reason: HostClientFailureReason
  message: string
  status?: number
}

export interface HostClientSuccess<T> {
  ok: true
  value: T
}

export type HostClientResult<T> = HostClientSuccess<T> | HostClientFailure

export interface HostClientConfig {
  /** Base URL of the OpenFox server, e.g. `http://127.0.0.1:10369`. */
  baseUrl: string
  /** Session token, when the host requires network authentication. */
  token?: string | undefined
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number | undefined
}

export interface HostSession {
  id: string
  title?: string
  projectId?: string
  /** The host returns the session's working directory. */
  workdir?: string
}

export interface HostWorkflowInfo {
  id: string
  name?: string
  description?: string
}

export interface HostClientDeps {
  /** Injection point for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch | undefined
}

/**
 * Build the launch message understood by the host's workflow resolver.
 *
 * The host parses `/<id> <arg> <arg> …` and maps the positional arguments
 * onto the workflow's declared parameters (sorted by `position`). We
 * therefore pass the parameters in that declared order.
 */
export function buildWorkflowLaunchMessage(
  workflowId: string,
  params: Record<string, string> = {},
  orderedParamIds?: string[],
): string {
  const ids = orderedParamIds && orderedParamIds.length > 0 ? orderedParamIds : Object.keys(params)
  const values = ids.map((id) => params[id]).filter((v): v is string => typeof v === 'string' && v.length > 0)
  return [`/${workflowId}`, ...values].join(' ')
}

function failure(reason: HostClientFailureReason, message: string, status?: number): HostClientFailure {
  return status === undefined ? { ok: false, reason, message } : { ok: false, reason, message, status }
}

/**
 * Validate the operator-supplied host base URL.
 *
 * The OpenFox server listens on the loopback interface, so only a
 * loopback origin is accepted. This keeps a mistyped or tampered setting
 * from making the plugin send its session token to an arbitrary host, and
 * it rules out an SSRF through the base URL.
 */
export function validateHostBaseUrl(
  baseUrl: string,
): { ok: true; origin: string } | { ok: false; message: string } {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    return { ok: false, message: 'OpenFox host base URL is not a valid URL' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, message: `unsupported scheme for the host base URL: ${parsed.protocol}` }
  }
  const host = parsed.hostname.toLowerCase()
  const isLoopback =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.localhost')
  if (!isLoopback) {
    return {
      ok: false,
      message: `the OpenFox host must be on the loopback interface, got "${parsed.hostname}"`,
    }
  }
  return { ok: true, origin: `${parsed.protocol}//${parsed.host}` }
}

/**
 * A thin, fail-closed client over the OpenFox local HTTP API.
 *
 * It is deliberately NOT constructed at import time: a plugin must opt in
 * (settings, or a test) before any request is attempted.
 */
export class HostClient {
  private readonly config: HostClientConfig
  private readonly fetchImpl: typeof fetch

  constructor(config: HostClientConfig, deps: HostClientDeps = {}) {
    this.config = config
    const impl = deps.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined)
    if (!impl) {
      throw new Error('HostClient requires a fetch implementation')
    }
    this.fetchImpl = impl
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<HostClientResult<T>> {
    const base = this.config.baseUrl?.trim()
    if (!base) {
      return failure('not-configured', 'OpenFox host base URL is not configured')
    }
    // The base URL is operator-supplied, so it is validated before any
    // request: only a loopback HTTP(S) origin is accepted. Without this
    // check a mistyped (or tampered) setting would make the plugin send
    // the session token to an arbitrary host.
    const validation = validateHostBaseUrl(base)
    if (!validation.ok) {
      return failure('bad-request', validation.message)
    }
    const url = `${validation.origin}${path}`
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (this.config.token) headers['x-session-token'] = this.config.token

    const timeoutMs = this.config.timeoutMs ?? 10_000
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      })

      if (res.status === 401 || res.status === 403) {
        return failure('unauthorized', `Host refused the request (${res.status})`, res.status)
      }
      if (res.status === 404) {
        return failure('not-found', `Host resource not found (${res.status})`, res.status)
      }
      if (res.status === 409) {
        return failure('conflict', `Host reported a conflict (${res.status})`, res.status)
      }
      if (res.status >= 400 && res.status < 500) {
        return failure('bad-request', `Host rejected the request (${res.status})`, res.status)
      }
      if (!res.ok) {
        return failure('server-error', `Host returned ${res.status}`, res.status)
      }

      const text = await res.text()
      if (!text) return { ok: true, value: undefined as T }
      try {
        return { ok: true, value: JSON.parse(text) as T }
      } catch {
        return failure('invalid-response', 'Host returned a non-JSON body')
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return failure('unreachable', `Host request timed out after ${timeoutMs}ms`)
      }
      return failure('unreachable', err instanceof Error ? err.message : String(err))
    } finally {
      clearTimeout(timer)
    }
  }

  /** `POST /api/sessions` — create a session bound to a host project. */
  async createSession(projectId: string, title?: string): Promise<HostClientResult<HostSession>> {
    if (!projectId) {
      return failure('bad-request', 'projectId is required to create a session')
    }
    const res = await this.request<{ session?: HostSession }>('POST', '/api/sessions', {
      projectId,
      ...(title ? { title } : {}),
    })
    if (!res.ok) return res
    const session = res.value?.session
    if (!session?.id) {
      return failure('invalid-response', 'Host did not return a session id')
    }
    return { ok: true, value: session }
  }

  /** `GET /api/sessions/:id` — read the session state. */
  async getSession(sessionId: string): Promise<HostClientResult<HostSession>> {
    if (!sessionId) return failure('bad-request', 'sessionId is required')
    return await this.request<HostSession>('GET', `/api/sessions/${encodeURIComponent(sessionId)}`)
  }

  /**
   * `POST /api/sessions/:id/message` — queue a message.
   *
   * A message starting with `/<workflow-id>` is resolved and launched by
   * the host as a workflow run.
   */
  async sendMessage(sessionId: string, content: string): Promise<HostClientResult<unknown>> {
    if (!sessionId) return failure('bad-request', 'sessionId is required')
    if (!content) return failure('bad-request', 'content is required')
    return await this.request<unknown>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/message`, {
      content,
    })
  }

  /**
   * Launch a workflow on an existing session.
   *
   * The host owns the execution: it resolves the workflow id, validates the
   * required parameters and runs the workflow. The plugin only queues the
   * launch message.
   */
  async launchWorkflow(
    sessionId: string,
    workflowId: string,
    params: Record<string, string> = {},
    orderedParamIds?: string[],
  ): Promise<HostClientResult<unknown>> {
    if (!workflowId) return failure('bad-request', 'workflowId is required')
    return await this.sendMessage(sessionId, buildWorkflowLaunchMessage(workflowId, params, orderedParamIds))
  }

  /** `POST /api/sessions/:id/stop` — stop a running session. */
  async stopSession(sessionId: string): Promise<HostClientResult<unknown>> {
    if (!sessionId) return failure('bad-request', 'sessionId is required')
    return await this.request<unknown>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/stop`, {})
  }

  /** `GET /api/workflows` — list the workflows the host can run. */
  async listWorkflows(): Promise<HostClientResult<HostWorkflowInfo[]>> {
    const res = await this.request<{
      defaults?: HostWorkflowInfo[]
      userItems?: HostWorkflowInfo[]
      projectItems?: HostWorkflowInfo[]
    }>('GET', '/api/workflows')
    if (!res.ok) return res
    const value = res.value
    return {
      ok: true,
      value: [...(value?.defaults ?? []), ...(value?.userItems ?? []), ...(value?.projectItems ?? [])],
    }
  }
}

/**
 * Resolve the host's local API base URL from the plugin runtime.
 *
 * The plugin runtime exposes `mode` and `configDirectory` only. The port
 * is a host configuration value, so it is read from the host's global
 * config file when present. This never contacts the server: it only reads
 * a configuration file.
 */
export function defaultHostBaseUrl(mode: 'production' | 'development'): string {
  // Mirrors the host's own default (chunk-D67RLN3F.js: `server.port`).
  return mode === 'development' ? 'http://127.0.0.1:10469' : 'http://127.0.0.1:10369'
}
