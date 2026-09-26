/**
 * Session spawner.
 *
 * Resolves OpenFox internals and uses the host `sessionManager` to create
 * sessions. The actual workflow chain driving is delegated to `chain.ts`.
 *
 * In production this relies on the dynamic import in `resolve-openfox.ts`.
 * In tests, the spawner takes an injected `createSession` function so unit
 * tests do not need a real OpenFox host.
 */

import type { QueueEntry } from './types.js'
import { getOpenFoxInternals } from './resolve-openfox.js'

export interface SessionLike {
  id: string
  workdir?: string
}

export interface SpawnerDeps {
  createSession?: (projectId: string, title: string) => Promise<SessionLike>
}

export function buildSessionTitle(entry: QueueEntry): string {
  return `[issue #${entry.issueNumber}] ${entry.title}`.slice(0, 200)
}

export async function spawnSessionFor(
  entry: QueueEntry,
  deps: SpawnerDeps = {},
): Promise<SessionLike> {
  if (deps.createSession) {
    return deps.createSession(entry.projectId, buildSessionTitle(entry))
  }
  const internals = await getOpenFoxInternals()
  if (!internals) {
    throw new Error(
      'OpenFox internals are not available. Either inject `createSession` for testing or ensure `openfox` is resolvable from the plugin loader.',
    )
  }
  const sm = internals.sessionManager as {
    createSession: (projectId: string, title: string) => SessionLike | Promise<SessionLike>
  }
  const session = await sm.createSession(entry.projectId, buildSessionTitle(entry))
  return session
}

export async function stopSession(sessionId: string, deps: { stopSession?: (id: string) => Promise<void> } = {}): Promise<void> {
  if (deps.stopSession) {
    await deps.stopSession(sessionId)
    return
  }
  const internals = await getOpenFoxInternals()
  if (!internals) {
    throw new Error('OpenFox internals are not available')
  }
  const sm = internals.sessionManager as {
    stopSession?: (id: string) => Promise<void>
    setRunning?: (id: string, running: boolean) => void
  }
  if (sm.stopSession) {
    await sm.stopSession(sessionId)
  } else if (sm.setRunning) {
    sm.setRunning(sessionId, false)
  }
}
