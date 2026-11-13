/**
 * AC32 — finding #30: the panel must not spend the operator's GitHub
 * quota for the display.
 *
 * THE DEFECT
 *
 * The panel refreshed every 10 seconds and called `automate.health`,
 * which queries the GitHub API: one `GET /user` plus one
 * `GET /issues/<n>` per mapped repository. With three mapped
 * repositories that is 4 requests every 10 seconds — ~24 per minute and
 * ~1,440 per hour — for a panel the operator merely left open. The
 * GitHub quota is 5,000 requests per hour, so the display alone would
 * consume ~30 % of it and starve the automatic scan.
 *
 * THE FIX
 *
 * A LOCAL RPC, `automate.hostStatus`, returns the host section (base
 * URL, token, transport, in-process surface) without touching the
 * network. The panel polls that. The FULL health check stays available
 * for the operator's explicit click on "Health check".
 *
 * Every test uses a fake `fetch`: no server, no port, no network.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { _resetLifecycleForTesting, register } from '../src/index.js'
import { makeSim, rpc, settle } from './helpers/sim.js'

const PANEL = readFileSync(join(import.meta.dirname, '..', 'src', 'panel', 'panel.html'), 'utf8')

afterEach(() => {
  _resetLifecycleForTesting()
  vi.unstubAllGlobals()
})

describe('AC32 #30 — the panel does not poll the GitHub API', () => {
  it('the panel polls the LOCAL host status, not the full health check', () => {
    // The refresh must not call `automate.health`: that RPC queries
    // GitHub.
    const refreshBody = PANEL.slice(PANEL.indexOf('async function refresh()'))
    const refreshCall = refreshBody.slice(0, refreshCallEnd(refreshBody))
    expect(refreshCall).toContain('hostStatus')
    expect(refreshCall).not.toContain('RPC_NAMESPACE}health')
  })

  it('the full health check stays available for the operator explicit click', () => {
    // The button is an explicit action: the operator asked for it.
    expect(PANEL).toContain('rpc(`${RPC_NAMESPACE}health`)')
  })

  it('the host status RPC answers WITHOUT any network call', async () => {
    const sim = makeSim({
      issues: [{ number: 1, title: 'I1' }],
      settings: { 'host.baseUrl': 'http://127.0.0.1:10999', 'host.sessionToken': 'tok' },
    })
    register(sim.registry)
    await settle()

    // Every request the plugin made so far is recorded by the harness.
    const before = sim.hostCalls.length

    const status = (await rpc(sim, 'automate.hostStatus')({}, sim.registry.context)) as {
      baseUrl: string
      baseUrlConfigured: boolean
      tokenConfigured: boolean
      transport: string
      inProcess: string
    }

    expect(status.baseUrl).toBe('http://127.0.0.1:10999')
    expect(status.baseUrlConfigured).toBe(true)
    expect(status.tokenConfigured).toBe(true)
    expect(status.transport).toBe('http')
    expect(status.inProcess).toBe('none')

    // NO request was made: neither to the host nor to GitHub.
    expect(sim.hostCalls.length).toBe(before)
    expect(sim.hostCalls.some((c) => c.url.includes('api.github.com'))).toBe(false)
    expect(sim.githubWrites).toHaveLength(0)
  })

  it('the health check still reports the same host section', async () => {
    // The manual check keeps the full information.
    const sim = makeSim({
      issues: [{ number: 1, title: 'I1' }],
      settings: { 'host.baseUrl': 'http://127.0.0.1:10999' },
    })
    register(sim.registry)
    await settle()

    const health = (await rpc(sim, 'automate.health')({}, sim.registry.context)) as {
      host: { baseUrl: string; transport: string }
    }
    expect(health.host.baseUrl).toBe('http://127.0.0.1:10999')
    expect(health.host.transport).toBe('http')
  })

  it('the panel does not call the health RPC in its refresh loop', () => {
    // A structural check: the ONLY `health` call in the panel is the
    // one bound to the operator's button.
    const healthCalls = PANEL.match(/rpc\(`\$\{RPC_NAMESPACE\}health`\)/g) ?? []
    expect(healthCalls).toHaveLength(1)
    // And it is inside the click handler.
    const clickIndex = PANEL.indexOf("getElementById('healthCheck').addEventListener")
    const healthIndex = PANEL.indexOf('rpc(`${RPC_NAMESPACE}health`)')
    expect(healthIndex).toBeGreaterThan(clickIndex)
  })
})

/** The end of the `refresh` function body. */
function refreshCallEnd(body: string): number {
  const marker = body.indexOf('renderActive()')
  return marker > 0 ? marker : body.length
}
