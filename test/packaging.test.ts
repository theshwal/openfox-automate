/**
 * Packaging tests (AC9).
 *
 * The plugin ships the compiled `dist/` output. Two defects made the
 * shipped artefact diverge from the source:
 *
 *  1. `npm run build` was a no-op when `dist/index.js` already existed
 *     (`test -f dist/index.js || tsc`), so a stale `dist/` was published
 *     instead of the current source.
 *  2. Nothing asserted that `dist/` matches `src/`.
 *
 * These tests build the plugin in a temporary directory and check the
 * result against the source. They never touch the real `dist/` of the
 * repository, and they never start a server.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, cpSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(__dirname, '..')

describe('AC9 — packaging: dist matches source', () => {
  let buildDir: string
  let builtDist: string

  beforeAll(() => {
    buildDir = mkdtempSync(join(tmpdir(), 'openfox-automate-build-'))
    // Copy the sources needed for a build (node_modules is symlinked so the
    // compiler is available without a network install).
    cpSync(join(REPO_ROOT, 'src'), join(buildDir, 'src'), { recursive: true })
    cpSync(join(REPO_ROOT, 'tsconfig.json'), join(buildDir, 'tsconfig.json'))
    cpSync(join(REPO_ROOT, 'package.json'), join(buildDir, 'package.json'))
    cpSync(join(REPO_ROOT, 'node_modules'), join(buildDir, 'node_modules'), {
      recursive: true,
      verbatimSymlinks: true,
    })

    execFileSync('npm', ['run', 'build'], {
      cwd: buildDir,
      stdio: 'pipe',
      encoding: 'utf8',
    })

    builtDist = join(buildDir, 'dist')
  }, 120_000)

  afterAll(() => {
    if (buildDir) rmSync(buildDir, { recursive: true, force: true })
  })

  it('produces the plugin entry point declared in the manifest', () => {
    expect(existsSync(join(builtDist, 'index.js'))).toBe(true)
    expect(existsSync(join(builtDist, 'index.d.ts'))).toBe(true)
  })

  it('copies the UI panel asset (it is not emitted by tsc)', () => {
    expect(existsSync(join(builtDist, 'panel.html'))).toBe(true)
    const built = readFileSync(join(builtDist, 'panel.html'), 'utf8')
    const source = readFileSync(join(REPO_ROOT, 'src', 'panel', 'panel.html'), 'utf8')
    expect(built).toBe(source)
  })

  it('rebuilds from scratch: the build is not a no-op when dist already exists', () => {
    // Reproduce the real failure mode: the repository ships a COMMITTED
    // `dist/` that can be stale relative to `src/`. The previous script
    // (`test -f dist/index.js || tsc`) skipped the compilation entirely
    // when dist/index.js existed, so the stale artefact was published.
    //
    // We simulate a stale dist by injecting a sentinel into the built
    // file, then rebuild: the sentinel must be GONE afterwards.
    const sentinel = '/* STALE_DIST_SENTINEL */'
    const indexPath = join(builtDist, 'index.js')
    const stale = `${sentinel}\n${readFileSync(indexPath, 'utf8')}`
    writeFileSync(indexPath, stale, 'utf8')
    expect(readFileSync(indexPath, 'utf8')).toContain(sentinel)

    execFileSync('npm', ['run', 'build'], {
      cwd: buildDir,
      stdio: 'pipe',
      encoding: 'utf8',
    })

    const indexJs = readFileSync(indexPath, 'utf8')
    // The build must have regenerated the file from the source.
    expect(indexJs).not.toContain(sentinel)
    // And it must contain the current source markers.
    expect(indexJs).toContain('normalizeWorkflowExecutionPayload')
    expect(indexJs).toContain('plan-issue-v3')
  })

  it('emits the current default workflow chain (a stale dist kept the v2 display names)', () => {
    const indexJs = readFileSync(join(builtDist, 'index.js'), 'utf8')
    expect(indexJs).toContain('plan-issue-v3')
    expect(indexJs).toContain('build-verify-v3')
    expect(indexJs).toContain('publish-pr-v1')
    // The v2 display names are not resolvable by the host (it looks up
    // workflows by metadata.id), so they must not be the compiled default.
    expect(indexJs).not.toContain("'Plan Issue v2'")
  })

  it('emits the host event adapter module', () => {
    expect(existsSync(join(builtDist, 'host-events.js'))).toBe(true)
    expect(existsSync(join(builtDist, 'host-events.d.ts'))).toBe(true)
    const adapter = readFileSync(join(builtDist, 'host-events.js'), 'utf8')
    expect(adapter).toContain('normalizeWorkflowExecutionPayload')
    expect(adapter).toContain('extractToolOutputText')
  })
})
