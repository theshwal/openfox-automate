/**
 * AC15 — Security policy and activation.
 *
 * These tests pin the SAFE defaults and the fail-closed behaviour:
 *
 *   - the plugin is INERT by default (dry run on, no startup scan);
 *   - the worker ceiling of 5 is enforced on every path;
 *   - the token budget stops a LIVE run;
 *   - an expired lease BLOCKS the issue instead of starting a second
 *     session for it;
 *   - no GitHub write and no session happens while the dry run is on.
 *
 * Everything is offline: the shared harness (`test/helpers/sim.ts`) fakes
 * both GitHub and the host.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { _resetLifecycleForTesting, register } from '../src/index.js'
import {
  DEFAULT_CONTROL_PLANE_OPTIONS,
  admit,
  emptyControlPlaneState,
  markRunning,
  recordTokenUsage,
  reclaimExpiredLeases,
  reserve,
} from '../src/control-plane.js'
import { controlPlaneOptionsFromSettings } from '../src/control-plane-store.js'
import { DEFAULT_SETTINGS } from '../src/types.js'
import { settingsSchema } from '../src/settings.js'
import { makeSim, rpc, settle } from './helpers/sim.js'

const T0 = 1_700_000_000_000

afterEach(() => {
  _resetLifecycleForTesting()
  vi.unstubAllGlobals()
})

describe('AC15 — safe defaults', () => {
  it('dry run is ON by default', () => {
    expect(DEFAULT_SETTINGS.dryRun).toBe(true)
    const field = settingsSchema.fields.find((f) => f.key === 'dryRun')
    expect(field?.default).toBe(true)
  })

  it('the startup scan is OFF by default', () => {
    expect(DEFAULT_SETTINGS['scan.startupScan']).toBe(false)
    const field = settingsSchema.fields.find((f) => f.key === 'scan.startupScan')
    expect(field?.default).toBe(false)
  })

  it('no GitHub write is enabled by default', () => {
    expect(DEFAULT_SETTINGS['post.closeOnSuccess']).toBe(false)
    expect(DEFAULT_SETTINGS['post.assignOnSuccess']).toBe(false)
    // `post.commentTemplate` is optional (no default): an empty template
    // means "do not comment".
    const field = settingsSchema.fields.find((f) => f.key === 'post.commentTemplate')
    expect(field?.default ?? '').toBe('')
  })

  it('creates NO session and NO workflow while the dry run is on', async () => {
    const sim = makeSim({ issues: [{ number: 1, title: 'A' }], settings: { dryRun: true } })
    register(sim.registry)
    await settle()

    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)
    await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)

    expect(sim.sessions).toHaveLength(0)
    expect(sim.launchedPrompts).toHaveLength(0)
    expect(sim.githubWrites).toHaveLength(0)
  })
})

describe('AC15 — worker ceiling of 5', () => {
  it('is enforced by the control-plane options even when the settings ask for more', () => {
    const options = controlPlaneOptionsFromSettings({
      'batch.maxConcurrency': 100,
      'batch.maxConcurrencyPerRepo': 100,
    })
    expect(options.maxWorkers).toBe(5)
    expect(options.maxWorkersPerRepo).toBe(5)
    expect(DEFAULT_CONTROL_PLANE_OPTIONS.maxWorkers).toBe(5)
  })

  it('never reserves more than 5 workers', () => {
    const state = emptyControlPlaneState()
    admit(
      state,
      Array.from({ length: 12 }, (_, i) => ({
        repoKey: `acme/r${i}`,
        projectId: 'p',
        issueNumber: i,
        title: 't',
        url: '',
      })),
      { now: T0 },
    )
    const result = reserve(state, {
      ...DEFAULT_CONTROL_PLANE_OPTIONS,
      maxWorkers: 5,
      maxWorkersPerRepo: 5,
      now: T0,
    })
    expect(result.reserved).toHaveLength(5)
  })
})

describe('AC15 — token budget stops a live run', () => {
  it('blocks the running issue when the budget is exceeded', () => {
    const state = emptyControlPlaneState()
    admit(state, [{ repoKey: 'acme/w', projectId: 'p', issueNumber: 1, title: 't', url: '' }], { now: T0 })
    reserve(state, { ...DEFAULT_CONTROL_PLANE_OPTIONS, now: T0 })
    markRunning(state, 'acme/w#1', 'sess-1', { now: T0 })

    recordTokenUsage(state, 'sess-1', { totalTokens: 900 }, { now: T0, maxTokensPerIssue: 1000 })
    expect(state.items['acme/w#1']?.status).toBe('running')

    recordTokenUsage(state, 'sess-1', { totalTokens: 200 }, { now: T0, maxTokensPerIssue: 1000 })
    expect(state.items['acme/w#1']?.status).toBe('blocked')
    expect(state.items['acme/w#1']?.error).toContain('token budget')
  })
})

describe('AC15 — an ambiguous session is blocked, never duplicated', () => {
  it('blocks the issue when its lease expires instead of starting a second session', () => {
    const state = emptyControlPlaneState()
    admit(state, [{ repoKey: 'acme/w', projectId: 'p', issueNumber: 1, title: 't', url: '' }], { now: T0 })
    reserve(state, { ...DEFAULT_CONTROL_PLANE_OPTIONS, leaseMs: 1000, now: T0 })
    markRunning(state, 'acme/w#1', 'sess-1', { now: T0 })

    // The lease expires while the host session may still be running.
    const reclaimed = reclaimExpiredLeases(state, { now: T0 + 2000 })
    expect(reclaimed).toHaveLength(1)
    expect(reclaimed[0]?.status).toBe('blocked')
    expect(reclaimed[0]?.error).toContain('may still be running')

    // The issue is NOT re-reserved: no second session for the same issue.
    const again = reserve(state, { ...DEFAULT_CONTROL_PLANE_OPTIONS, leaseMs: 1000, now: T0 + 2000 })
    expect(again.reserved).toHaveLength(0)
  })

  it('a second scheduler cannot start a second session for the same issue', async () => {
    // ONE issue only, so any second session would be a duplicate.
    const sim = makeSim({ issues: [{ number: 1, title: 'A' }] })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)

    // The control plane starts the issue.
    await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)
    await settle()
    expect(sim.sessions).toHaveLength(1)

    // The legacy path is asked to start the SAME issue again.
    const queue = JSON.parse(sim.backing.get('queue') as string) as Array<{ id: string; status: string }>
    await expect(
      rpc(sim, 'automate.startIssue')({ queueId: queue[0]!.id }, sim.registry.context),
    ).rejects.toThrow(/cannot start entry in status/)

    expect(sim.sessions).toHaveLength(1)
  })
})
