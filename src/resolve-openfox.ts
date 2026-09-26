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

import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

export interface OpenFoxInternals {
  sessionManager: unknown
  launchWorkflowRun: unknown
  llmClient: unknown
}

interface CachedResolution {
  internals: OpenFoxInternals | null
  error: string | null
}

let cached: CachedResolution | null = null

async function resolveOpenFoxPath(): Promise<string> {
  const resolveFn = (import.meta as unknown as { resolve?: (s: string) => Promise<string> | string }).resolve
  let resolved: string
  if (typeof resolveFn === 'function') {
    resolved = await resolveFn.call(import.meta, 'openfox')
  } else {
    throw new Error('import.meta.resolve is not available in this runtime')
  }
  if (resolved.endsWith('package.json')) {
    return dirname(fileURLToPath(resolved))
  }
  return dirname(fileURLToPath(resolved))
}

export async function getOpenFoxInternals(): Promise<OpenFoxInternals | null> {
  if (cached) return cached.internals

  try {
    const openfoxRoot = await resolveOpenFoxPath()
    const pkg = JSON.parse(readFileSync(join(openfoxRoot, 'package.json'), 'utf-8')) as { version?: string }
    void pkg
    const distServer = join(openfoxRoot, 'dist', 'server')
    const distUrl = pathToFileURL(distServer + '/').href

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
      cached = {
        internals: null,
        error: `OpenFox modules found but missing expected exports at ${distServer}`,
      }
      return null
    }

    cached = {
      internals: { sessionManager, launchWorkflowRun, llmClient: null },
      error: null,
    }
    return cached.internals
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    cached = { internals: null, error }
    return null
  }
}

export function getResolveError(): string | null {
  return cached?.error ?? null
}

export function isOpenFoxInternalsAvailable(): boolean {
  return cached?.internals != null
}

export function _resetForTesting(): void {
  cached = null
}
