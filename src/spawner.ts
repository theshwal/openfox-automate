/**
 * Session spawner.
 *
 * The plugin creates one session per issue. The host access goes through
 * the ORCHESTRATION PORT (`src/orchestration.ts`), which resolves the
 * host surface in order:
 *
 *   1. `context.host` — an in-process facade, when the host provides one;
 *   2. `context.openFoxInternals` — the legacy in-process surface;
 *   3. the SUPPORTED HTTP API (`src/host-client.ts`).
 *
 * This module used to resolve the host ITSELF, which meant it only knew
 * about paths 1 and 2. On OpenFox 2.0.160 and 2.0.161 the host exposes
 * NEITHER to a plugin, so the plugin could not create a session at all:
 * the session creation failed with "OpenFox host orchestration is not
 * available" even though the plugin already had a working HTTP client.
 */

import type { QueueEntry } from './types.js'
import type { OpenFoxOrchestration } from './orchestration.js'

export interface SessionLike {
  id: string
  workdir?: string
}

export interface SpawnerDeps {
  createSession?: (projectId: string, title: string) => Promise<SessionLike>
  context?: unknown
  /** The orchestration port; defaults to the host-backed one. */
  orchestration?: OpenFoxOrchestration
}

export function buildSessionTitle(entry: QueueEntry): string {
  return `[issue #${entry.issueNumber}] ${entry.title}`.slice(0, 200)
}

export async function spawnSessionFor(entry: QueueEntry, deps: SpawnerDeps = {}): Promise<SessionLike> {
  // The host's sessionManager requires a real projectId (UUID). The plugin
  // resolves repoKey → host-projectId when the entry is added
  // (see `repos.mapping`), so by spawn time `entry.projectId` is the value
  // the host understands.
  const hostProjectId = entry.projectId
  const title = buildSessionTitle(entry)
  if (deps.createSession) {
    return deps.createSession(hostProjectId, title)
  }
  if (deps.orchestration) {
    return await deps.orchestration.createSession(hostProjectId, title)
  }
  throw new Error(
    'OpenFox host orchestration is not available; cannot create a session. ' +
      'The orchestration port must be provided (it resolves context.host, ' +
      'context.openFoxInternals, or the supported HTTP API).',
  )
}

export async function stopSession(
  sessionId: string,
  deps: {
    stopSession?: (id: string) => Promise<void> | void
    context?: unknown
    orchestration?: OpenFoxOrchestration
  } = {},
): Promise<void> {
  if (deps.stopSession) {
    await deps.stopSession(sessionId)
    return
  }
  if (deps.orchestration) {
    await deps.orchestration.stopSession(sessionId)
    return
  }
  throw new Error('OpenFox host orchestration is not available; cannot stop the session.')
}
