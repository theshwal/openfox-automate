/**
 * Session spawner.
 *
 * Uses `context.host` (Plugin API v2.1+) when available, with fallback
 * to `context.openFoxInternals` (legacy) and finally to a dynamic import.
 */

import type { PluginContext } from 'openfox/plugin'
import type { QueueEntry } from './types.js'
import { getHostInternal } from './resolve-openfox.js'

export interface SessionLike {
  id: string
  workdir?: string
}

export interface SpawnerDeps {
  createSession?: (projectId: string, title: string) => Promise<SessionLike>
  context?: PluginContext
}

export function buildSessionTitle(entry: QueueEntry): string {
  return `[issue #${entry.issueNumber}] ${entry.title}`.slice(0, 200)
}

export async function spawnSessionFor(entry: QueueEntry, deps: SpawnerDeps = {}): Promise<SessionLike> {
  if (deps.createSession) {
    return deps.createSession(entry.repoKey, buildSessionTitle(entry))
  }
  const internal = await getHostInternal(deps.context)
  if (!internal) {
    throw new Error(
      'OpenFox host orchestration is not available. Either inject createSession for testing, or ensure the host exposes context.host or context.openFoxInternals.',
    )
  }
  if (internal.kind === 'facade') {
    const s = await internal.facade.sessions.create({
      projectId: entry.repoKey,
      title: buildSessionTitle(entry),
    })
    return { id: s.sessionId, ...(s.workdir !== undefined ? { workdir: s.workdir } : {}) }
  }
  return await internal.legacy.sessionManager.createSession(entry.repoKey, buildSessionTitle(entry))
}

export async function stopSession(
  sessionId: string,
  deps: { stopSession?: (id: string) => Promise<void>; context?: PluginContext } = {},
): Promise<void> {
  if (deps.stopSession) {
    await deps.stopSession(sessionId)
    return
  }
  const internal = await getHostInternal(deps.context)
  if (!internal) {
    throw new Error('OpenFox host orchestration is not available')
  }
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
}
