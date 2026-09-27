/**
 * OpenFox internals resolver.
 *
 * Prefers the host-exposed `context.openFoxInternals` (apiVersion 2,
 * added by the host when it wires sessionManager + runWorkflow into
 * the plugin context). Falls back to a dynamic import of the host's
 * dist/server for older hosts that don't expose internals yet.
 */

import type { PluginContext } from 'openfox/plugin'

/**
 * Local shape matching the host-exposed openFoxInternals.
 * (Defined here as well as a fallback until the host npm package
 * exports PluginOpenFoxInternals.)
 */
export interface PluginOpenFoxInternalsLocal {
  sessionManager: {
    createSession: (projectId: string, title: string) => Promise<{ id: string; workdir?: string }>
    setRunning: (sessionId: string, running: boolean) => void
  }
  runWorkflow: (sessionId: string, payload: unknown) => void
}

export type OpenFoxInternals = PluginOpenFoxInternalsLocal

let cachedFallback: OpenFoxInternals | null | undefined

async function tryDynamicImport(): Promise<OpenFoxInternals | null> {
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
      sessionManager: sessionManager as OpenFoxInternals['sessionManager'],
      runWorkflow: ((sessionId: string, payload: unknown) => {
        const args = payload as Record<string, unknown>
        ;(launchWorkflowRun as (deps: unknown, payload: unknown) => unknown)(
          {
            sessionManager,
            sessionId,
            ...(args.workflowId ? { workflowId: args.workflowId } : {}),
            ...(args.params ? { params: args.params } : {}),
          },
          payload,
        )
      }) as unknown,
    } as unknown as OpenFoxInternals
    return cachedFallback
  } catch {
    cachedFallback = null
    return null
  }
}

export async function getOpenFoxInternals(context?: PluginContext): Promise<OpenFoxInternals | null> {
  // Host may expose openFoxInternals even when its npm type doesn't (e.g. local
  // dev install ahead of publish). Access it loosely and trust the host.
  const fromContext = (context as { openFoxInternals?: OpenFoxInternals } | undefined)?.openFoxInternals
  if (fromContext) {
    return fromContext
  }
  return await tryDynamicImport()
}

export function getOpenFoxInternalsSync(context: PluginContext | undefined): OpenFoxInternals | null {
  return (context as { openFoxInternals?: OpenFoxInternals } | undefined)?.openFoxInternals ?? null
}

export function getResolveError(): string | null {
  return null
}

export function isOpenFoxInternalsAvailable(): boolean {
  return true
}

export function _resetForTesting(): void {
  cachedFallback = undefined
}
