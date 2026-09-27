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
  // The host's sessionManager requires a real projectId (UUID). The plugin
  // resolves repoKey → host-projectId when the entry is added
  // (see `repos.mapping`), so by spawn time `entry.projectId` is the value
  // the host understands.
  const hostProjectId = entry.projectId
  if (deps.createSession) {
    return deps.createSession(hostProjectId, buildSessionTitle(entry))
  }
  const internal = await getHostInternal(deps.context)
  if (!internal) {
    throw new Error(
      'OpenFox host orchestration is not available. Either inject createSession for testing, or ensure the host exposes context.host or context.openFoxInternals.',
    )
  }
  if (internal.kind === 'facade') {
    const s = await internal.facade.sessions.create({
      projectId: hostProjectId,
      title: buildSessionTitle(entry),
    })
    return { id: s.sessionId, ...(s.workdir !== undefined ? { workdir: s.workdir } : {}) }
  }
  return await internal.legacy.sessionManager.createSession(hostProjectId, buildSessionTitle(entry))
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
