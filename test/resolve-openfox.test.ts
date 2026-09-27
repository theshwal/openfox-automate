import { afterEach, describe, expect, it } from 'vitest'
import {
  _resetForTesting,
  getHostInternal,
  type PluginHostFacade,
  type PluginOpenFoxInternalsLegacy,
} from '../src/resolve-openfox.js'

function makeFacade(overrides: Partial<PluginHostFacade> = {}): PluginHostFacade {
  const created: Array<{ projectId: string; title?: string }> = []
  const stopped: string[] = []
  const launches: Array<Record<string, unknown>> = []
  return {
    sessions: {
      create: async (input) => {
        created.push(input)
        return { sessionId: `facade-${created.length}`, workdir: '/tmp/fac' }
      },
      stop: (sessionId) => {
        stopped.push(sessionId)
      },
      ...overrides.sessions,
    },
    workflows: {
      launch: (input) => {
        launches.push({ ...input })
      },
      ...overrides.workflows,
    },
  }
}

function makeLegacy(): PluginOpenFoxInternalsLegacy {
  const created: Array<[string, string]> = []
  const runs: Array<[string, Record<string, unknown>]> = []
  return {
    sessionManager: {
      createSession: async (projectId, title) => {
        created.push([projectId, title])
        return { id: `legacy-${created.length}`, workdir: '/tmp/leg' }
      },
      setRunning: (_sessionId, _running) => undefined,
    },
    runWorkflow: (sessionId, payload) => {
      runs.push([sessionId, payload as Record<string, unknown>])
    },
  }
}

afterEach(() => _resetForTesting())

describe('getHostInternal', () => {
  it('returns facade when context.host is provided', async () => {
    const facade = makeFacade()
    const internal = await getHostInternal({ host: facade } as unknown as Parameters<
      typeof getHostInternal
    >[0])
    expect(internal).not.toBeNull()
    expect(internal?.kind).toBe('facade')
    if (internal?.kind === 'facade') {
      const s = await internal.facade.sessions.create({ projectId: 'p', title: 't' })
      expect(s.sessionId).toBe('facade-1')
      expect(s.workdir).toBe('/tmp/fac')
    }
  })

  it('falls back to legacy when only context.openFoxInternals is provided', async () => {
    const legacy = makeLegacy()
    const internal = await getHostInternal({
      openFoxInternals: legacy,
    } as unknown as Parameters<typeof getHostInternal>[0])
    expect(internal).not.toBeNull()
    expect(internal?.kind).toBe('legacy')
  })

  it('prefers facade over legacy when both are present', async () => {
    const facade = makeFacade()
    const legacy = makeLegacy()
    const internal = await getHostInternal({
      host: facade,
      openFoxInternals: legacy,
    } as unknown as Parameters<typeof getHostInternal>[0])
    expect(internal?.kind).toBe('facade')
  })

  it('returns null when context is undefined and dynamic import cannot resolve openfox', async () => {
    _resetForTesting()
    const internal = await getHostInternal(undefined)
    expect(internal).toBeNull()
  })
})
