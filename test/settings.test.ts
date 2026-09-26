import { describe, expect, it } from 'vitest'
import {
  parseRepoMapping,
  parseChain,
  parseRepoOverrides,
  parseIgnoreLabels,
  readSettings,
} from '../src/settings.js'
import { DEFAULT_SETTINGS } from '../src/types.js'

describe('parseRepoMapping', () => {
  it('parses valid lines', () => {
    const r = parseRepoMapping('org/a = p1\norg/b=p2')
    expect(r).toEqual([
      { repoKey: 'org/a', projectId: 'p1' },
      { repoKey: 'org/b', projectId: 'p2' },
    ])
  })

  it('ignores blanks and comments', () => {
    const r = parseRepoMapping('# comment\n\n  \norg/a=p1')
    expect(r).toHaveLength(1)
  })

  it('ignores malformed lines without =', () => {
    expect(parseRepoMapping('just-text')).toEqual([])
  })

  it('ignores lines without slash in repoKey', () => {
    expect(parseRepoMapping('notrepo=p1')).toEqual([])
  })
})

describe('parseChain', () => {
  it('parses ordered list', () => {
    expect(parseChain('a\nb\nc')).toEqual(['a', 'b', 'c'])
  })

  it('ignores blanks and comments', () => {
    expect(parseChain('# comment\n\nA\n  ')).toEqual(['A'])
  })

  it('returns empty for undefined or empty', () => {
    expect(parseChain(undefined)).toEqual([])
    expect(parseChain('')).toEqual([])
  })
})

describe('parseRepoOverrides', () => {
  it('parses comma-separated chain per repo', () => {
    const m = parseRepoOverrides('org/a=A,B,C')
    expect(m.get('org/a')).toEqual(['A', 'B', 'C'])
  })

  it('returns empty map for empty input', () => {
    expect(parseRepoOverrides(undefined).size).toBe(0)
  })

  it('ignores invalid entries', () => {
    const m = parseRepoOverrides('org/a=A,B\nnotrepo=C\nbrokenline')
    expect(m.get('org/a')).toEqual(['A', 'B'])
    expect(m.has('notrepo')).toBe(false)
  })
})

describe('parseIgnoreLabels', () => {
  it('parses comma-separated labels, lowercase, trimmed', () => {
    expect(parseIgnoreLabels('WontFix, duplicate , Needs-Discussion')).toEqual(['wontfix', 'duplicate', 'needs-discussion'])
  })

  it('returns empty for empty input', () => {
    expect(parseIgnoreLabels(undefined)).toEqual([])
    expect(parseIgnoreLabels('')).toEqual([])
  })
})

describe('readSettings', () => {
  it('fills defaults for missing keys', () => {
    const s = readSettings({})
    expect(s['scan.refreshMinutes']).toBe(DEFAULT_SETTINGS['scan.refreshMinutes'])
    expect(s['batch.maxConcurrency']).toBe(DEFAULT_SETTINGS['batch.maxConcurrency'])
  })

  it('overrides defaults when provided', () => {
    const s = readSettings({ 'scan.refreshMinutes': 5, dryRun: true })
    expect(s['scan.refreshMinutes']).toBe(5)
    expect(s.dryRun).toBe(true)
  })

  it('treats empty string as default', () => {
    const s = readSettings({ 'scan.refreshMinutes': '' as unknown as number })
    expect(s['scan.refreshMinutes']).toBe(DEFAULT_SETTINGS['scan.refreshMinutes'])
  })
})
