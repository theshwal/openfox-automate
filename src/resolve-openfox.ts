/**
 * OpenFox internals resolver.
 *
 * Prefers the host-exposed `context.host` (Plugin API v2.1+, exposes
 * `sessions.create / sessions.stop / workflows.launch`). Falls back to the
 * older `context.openFoxInternals` shape for backward compatibility, then to
 * a dynamic import of the host's dist/server for hosts that don't expose
 * either.
 */

import type { PluginContext } from 'openfox/plugin'

/**
 * Minimal surface the plugin needs from the host. The host exposes this via
 * `context.host` on hosts that support plugin orchestration (>=2.1).
 */
export interface PluginHostFacade {
  sessions: {
    create(input: { projectId: string; title?: string }): Promise<{ sessionId: string; workdir?: string }>
    stop(sessionId: string): void
  }
  workflows: {
    launch(input: {
      sessionId: string
      workflowId: string
      params?: Record<string, string>
      content?: string
      subGroup?: string
    }): void
  }
}

/**
 * Legacy surface (apiVersion 2.0). Kept as a fallback for hosts that
 * expose `openFoxInternals` but not the newer `host` shape.
 */
export interface PluginOpenFoxInternalsLegacy {
  sessionManager: {
    createSession: (projectId: string, title: string) => Promise<{ id: string; workdir?: string }>
    setRunning: (sessionId: string, running: boolean) => void
  }
  runWorkflow: (sessionId: string, payload: unknown) => void
}

/** Discriminated union: 'kind' tag identifies the host surface. */
export type PluginHostInternal =
  { kind: 'facade'; facade: PluginHostFacade } | { kind: 'legacy'; legacy: PluginOpenFoxInternalsLegacy }

let cachedFallback: PluginHostInternal | null | undefined

async function tryDynamicImport(): Promise<PluginHostInternal | null> {
  if (cachedFallback !== undefined) return cachedFallback
  try {
    const resolveFn = (import.meta as unknown as { resolve?: (s: string) => Promise<string> | string })
      .resolve
    if (typeof resolveFn !== 'function') {
      cachedFallback = null
      return null
    }
    const resolved = await resolveFn.call(import.meta, 'openfox')
    const { fileURLToPath, pathToFileURL } = await import('node:url')
    const { dirname, join } = await import('node:path')
    const openfoxRoot = resolved.endsWith('package.json')
      ? dirname(fileURLToPath(resolved))
      : dirname(fileURLToPath(resolved))
    const distUrl = pathToFileURL(join(openfoxRoot, 'dist', 'server') + '/').href
    const sessionMod = (await import(/* @vite-ignore */ new URL('./session/index.js', distUrl).href)) as {
      sessionManager?: unknown
      default?: { sessionManager?: unknown }
    }
    const runnerMod = (await import(/* @vite-ignore */ new URL('./runner/launch.js', distUrl).href)) as {
      launchWorkflowRun?: unknown
    }
    const sessionManager =
      sessionMod.sessionManager ??
      (sessionMod.default as { sessionManager?: unknown } | undefined)?.sessionManager
    const launchWorkflowRun = runnerMod.launchWorkflowRun
    if (!sessionManager || !launchWorkflowRun) {
      cachedFallback = null
      return null
    }
    cachedFallback = {
      kind: 'legacy',
      legacy: {
        sessionManager: sessionManager as PluginOpenFoxInternalsLegacy['sessionManager'],
        runWorkflow: (sessionId: string, payload: unknown): void => {
          const args = payload as Record<string, unknown>
          const runner = launchWorkflowRun as (deps: unknown, payload: unknown) => unknown
          runner(
            {
              sessionManager,
              sessionId,
              ...(args.workflowId ? { workflowId: args.workflowId } : {}),
              ...(args.params ? { params: args.params } : {}),
            },
            payload,
          )
        },
      },
    }
    return cachedFallback ?? null
  } catch {
    cachedFallback = null
    return null
  }
}

/** Resolve the orchestration surface. */
export async function getHostInternal(context?: PluginContext): Promise<PluginHostInternal | null> {
  // Preferred: host exposes PluginHost facade via context.host
  const hostFacade = (context as { host?: PluginHostFacade } | undefined)?.host
  if (hostFacade) return { kind: 'facade', facade: hostFacade }

  // Legacy: context.openFoxInternals
  const legacy = (context as { openFoxInternals?: PluginOpenFoxInternalsLegacy } | undefined)
    ?.openFoxInternals
  if (legacy) return { kind: 'legacy', legacy }

  // Last resort: dynamic import of the host's dist/server
  return await tryDynamicImport()
}

/** Convenience: create session + launch each chain step. */
export async function createSessionAndLaunch(
  context: PluginContext,
  entry: { repoKey: string; title: string },
  chain: Array<{ workflowId: string }>,
): Promise<{ sessionId: string } | null> {
  const internal = await getHostInternal(context)
  if (!internal) return null
  if (internal.kind === 'facade') {
    const session = await internal.facade.sessions.create({ projectId: entry.repoKey, title: entry.title })
    for (const step of chain) {
      internal.facade.workflows.launch({ sessionId: session.sessionId, workflowId: step.workflowId })
    }
    return { sessionId: session.sessionId }
  }
  for (const step of chain) {
    internal.legacy.runWorkflow(/* sessionId will be set after create */ '', { workflowId: step.workflowId })
  }
  return null
}

export function getResolveError(): string | null {
  return null
}

export function _resetForTesting(): void {
  cachedFallback = undefined
}
