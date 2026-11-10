/**
 * OpenFox host-surface resolver.
 *
 * Prefers the host-exposed `context.host` (which exposes
 * `sessions.create / sessions.stop / workflows.launch`), then the older
 * `context.openFoxInternals` shape for backward compatibility.
 *
 * There is NO dynamic import of the host's internals any more: the
 * published package does not expose them (`openfox` only exports
 * `createServer` / `createServerHandle`), so such an import could never
 * work, and it coupled the plugin to the server's module layout.
 *
 * When neither surface is available the resolver returns null and the
 * caller must use the supported HTTP client (`src/host-client.ts`).
 * Failing closed is deliberate: the plugin must not invent an API.
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

/**
 * The dynamic-import fallback has been REMOVED.
 *
 * It resolved `openfox` and imported `dist/server/session/index.js` and
 * `dist/server/runner/launch.js` — paths that do not exist in the
 * published package (`openfox` only exports `createServer` /
 * `createServerHandle`), so the fallback could never work. It also
 * coupled the plugin to the host's internal module layout, which is not
 * part of the package's `exports` map and moves between releases.
 *
 * The supported replacement is `src/host-client.ts`, which uses the
 * host's documented local HTTP API.
 */

/** Resolve the orchestration surface. */
export async function getHostInternal(context?: PluginContext): Promise<PluginHostInternal | null> {
  // Preferred: host exposes PluginHost facade via context.host
  const hostFacade = (context as { host?: PluginHostFacade } | undefined)?.host
  if (hostFacade) return { kind: 'facade', facade: hostFacade }

  // Legacy: context.openFoxInternals (kept for hosts that expose it)
  const legacy = (context as { openFoxInternals?: PluginOpenFoxInternalsLegacy } | undefined)
    ?.openFoxInternals
  if (legacy) return { kind: 'legacy', legacy }

  // No in-process surface: the caller must use the supported HTTP client
  // (`src/host-client.ts`). Returning null here is FAIL CLOSED — the
  // plugin must not invent an API or import the host's internals.
  return null
}

export function getResolveError(): string | null {
  return null
}

export function _resetForTesting(): void {
  // Nothing is cached any more: the resolver is a pure lookup.
}
