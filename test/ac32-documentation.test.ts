/**
 * AC32 — finding #29: the documentation must describe the API that
 * actually exists.
 *
 * The README, the French README and the CHANGELOG described an API the
 * plugin does NOT use any more:
 *
 *   - `PluginContext.openFoxInternals` (and `context.host`) — a plugin
 *     never gets them: on OpenFox 2.0.161 `PluginContext` declares only
 *     id, version, runtime, logger, storage, settings, notify and
 *     publish;
 *   - the workflow names `Plan Issue v2`, `Build & Verify Auto v2` and
 *     `Delivery v2` — the code runs `plan-issue-v3`, `build-verify-v3`
 *     and `publish-pr-v1`;
 *   - the settings `host.baseUrl` and `host.sessionToken`, which the
 *     plugin NEEDS to reach the host, were not documented at all.
 *
 * These tests fail when the documentation drifts back.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')

const README = readFileSync(join(ROOT, 'README.md'), 'utf8')
const README_FR = readFileSync(join(ROOT, 'README.fr.md'), 'utf8')
const CHANGELOG = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')

const DOCS = [
  { name: 'README.md', text: README },
  { name: 'README.fr.md', text: README_FR },
  { name: 'CHANGELOG.md', text: CHANGELOG },
]

describe('AC32 #29 — the documentation describes the real API', () => {
  it('no document describes the in-process internals the host does not expose', () => {
    for (const doc of DOCS) {
      // `openFoxInternals` is the surface the plugin CANNOT use. It may
      // only be mentioned to say that it is NOT available — in English or
      // in French.
      const mentions = doc.text
        .split('\n')
        .filter((line) => line.includes('openFoxInternals'))
        .filter(
          (line) =>
            !/\b(no|not|neither|without|cannot|never)\b/i.test(line) &&
            !/\b(ni|ni…|pas|sans|jamais)\b/i.test(line),
        )
      expect(mentions, `${doc.name} still documents openFoxInternals as available`).toEqual([])
    }
  })

  it('no document names the obsolete v2 workflows', () => {
    for (const doc of DOCS) {
      for (const obsolete of ['Plan Issue v2', 'Build & Verify Auto v2', 'Delivery v2']) {
        expect(doc.text.includes(obsolete), `${doc.name} still names "${obsolete}"`).toBe(false)
      }
    }
  })

  it('the READMEs document the real workflow chain', () => {
    for (const doc of [README, README_FR]) {
      for (const workflow of ['plan-issue-v3', 'build-verify-v3', 'publish-pr-v1']) {
        expect(doc.includes(workflow), `the workflow "${workflow}" is not documented`).toBe(true)
      }
    }
  })

  it('the READMEs document the host settings the plugin needs', () => {
    for (const doc of [README, README_FR]) {
      expect(doc.includes('host.baseUrl')).toBe(true)
      expect(doc.includes('host.sessionToken')).toBe(true)
    }
  })

  it('the READMEs document the local HTTP API the plugin actually uses', () => {
    for (const doc of [README, README_FR]) {
      expect(doc.includes('/api/sessions')).toBe(true)
      expect(doc.includes('/api/projects/')).toBe(true)
    }
  })

  it('the READMEs document the local host status RPC the panel polls', () => {
    for (const doc of [README, README_FR]) {
      expect(doc.includes('automate.hostStatus')).toBe(true)
    }
  })

  it('the READMEs document the safe defaults', () => {
    // The defaults the operator relies on: no session, no GitHub write
    // and no workflow until the dry run is deliberately turned off.
    expect(README).toMatch(/`dryRun`\s*\|\s*`true`/)
    expect(README_FR).toMatch(/`dryRun`\s*\|\s*`true`/)
    expect(README).toMatch(/`scan\.startupScan`\s*\|\s*`false`/)
    expect(README_FR).toMatch(/`scan\.startupScan`\s*\|\s*`false`/)
  })

  it('the READMEs no longer promise an auto-merge', () => {
    for (const doc of [README, README_FR]) {
      // The plugin has NO auto-merge path. The documentation may SAY so
      // (that is useful), but it must not announce one.
      const promises = doc
        .split('\n')
        .filter(
          (line) => line.toLowerCase().includes('auto-merge') || line.toLowerCase().includes('auto merge'),
        )
        .filter((line) => !/\b(no|not|neither|without|cannot|never)\b/i.test(line))
        .filter((line) => !/\b(ni|pas|sans|jamais|aucun)\b/i.test(line))
      expect(promises, 'the documentation must not announce an auto-merge').toEqual([])
    }
  })
})
