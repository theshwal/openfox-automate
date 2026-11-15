/**
 * AC32 — code review: a launch that does NOT start must be VISIBLE.
 *
 * THE DEFECT
 *
 * When the plugin refused a launch (the workflow's declared parameters
 * could not be read, or a required one was missing), the outcome was
 * only logged. The issue stayed 'running' in BOTH views, with NO error,
 * and the panel showed a running issue with no workflow behind it and no
 * reason. The operator had no way to tell a stuck issue from a working
 * one.
 *
 * The message was also wrong: `launched: false` covers TWO different
 * situations — a REFUSAL (the host was never asked) and a QUEUEING (the
 * host accepted the task and waits for a slot) — and the plugin always
 * announced the second one ("its task slot limit was reached").
 *
 * THE FIX
 *
 *   - `LaunchOutcome.failure` distinguishes 'refused' from 'queued', and
 *     the warning says which;
 *   - a launch that does not start BLOCKS the issue in both views, with
 *     the reason, and notifies the operator.
 *
 * Every test uses a fake host: no server, no port, no network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { _resetLifecycleForTesting, register } from '../src/index.js'
import { makeFaithfulSim, readJson, settle } from './helpers/faithful-host.js'
import type { QueueEntry } from '../src/types.js'

afterEach(() => {
  _resetLifecycleForTesting()
  vi.unstubAllGlobals()
})

describe('AC32 — a refused launch is visible', () => {
  it('blocks the issue in BOTH views, with the reason, and notifies', async () => {
    // The host does not know the workflow: the plugin cannot read its
    // declared parameters, so it refuses the launch.
    const sim = makeFaithfulSim({
      issues: [{ number: 1, title: 'I1' }],
      chain: ['plan-issue-v3'],
      workflows: [],
    })
    register(sim.registry)
    await settle()
    await sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!.fn({}, sim.registry.context)
    await sim.calls.rpc.find((r) => r.name === 'automate.controlPlaneSchedule')!.fn({}, sim.registry.context)
    await settle()

    const queue = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
    const cp = readJson<{ items: Record<string, { status: string; error?: string }> }>(
      sim.backing,
      'control_plane',
    )

    // The issue is NOT 'running' any more: nothing is running.
    expect(queue[0]?.status).toBe('blocked')
    expect(cp?.items['acme/widgets#1']?.status).toBe('blocked')
    // And both views carry the SAME reason.
    expect(queue[0]?.error).toContain('could not start workflow plan-issue-v3')
    expect(cp?.items['acme/widgets#1']?.error).toContain('could not start workflow plan-issue-v3')

    // The operator is told.
    expect(sim.context.notify).toHaveBeenCalled()

    // And the warning does NOT claim a slot limit: the host was never
    // asked to run anything.
    const warnings = sim.logger.warn.mock.calls.map((c) => String(c[0]))
    expect(warnings.some((w) => w.includes('REFUSED'))).toBe(true)
    expect(warnings.some((w) => w.includes('slot limit was reached'))).toBe(false)
  })

  it('the two views agree, so no drift is reported', async () => {
    const sim = makeFaithfulSim({
      issues: [{ number: 1, title: 'I1' }],
      chain: ['plan-issue-v3'],
      workflows: [],
    })
    register(sim.registry)
    await settle()
    await sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!.fn({}, sim.registry.context)
    await sim.calls.rpc.find((r) => r.name === 'automate.controlPlaneSchedule')!.fn({}, sim.registry.context)
    await settle()

    const status = (await sim.calls.rpc
      .find((r) => r.name === 'automate.controlPlaneStatus')!
      .fn({}, sim.registry.context)) as { divergences: string[] }
    expect(status.divergences).toEqual([])
  })

  it('a launch refused at the CHAIN ADVANCE also blocks the issue', async () => {
    // The first step works, the second one is REFUSED: the issue must not
    // stay 'running' either.
    //
    // The refusal is REAL: the host stops DECLARING build-verify-v3, so
    // its parameters cannot be mapped and the plugin refuses the launch
    // (fail-closed) instead of guessing the argument order.
    const workflows = [
      {
        id: 'plan-issue-v3',
        parameters: [
          { id: 'issue_ref', position: 0, required: true },
          { id: 'repo', position: 1, required: false },
        ],
      },
      { id: 'build-verify-v3', parameters: [{ id: 'workdir', position: 0, required: false }] },
    ]
    const sim = makeFaithfulSim({
      issues: [{ number: 1, title: 'I1' }],
      chain: ['plan-issue-v3', 'build-verify-v3'],
      workflows,
    })
    register(sim.registry)
    await settle()
    await sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!.fn({}, sim.registry.context)
    await sim.calls.rpc.find((r) => r.name === 'automate.controlPlaneSchedule')!.fn({}, sim.registry.context)
    await settle()

    // The first step DID start: the entry is running and the second step
    // is still pending.
    const launched = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
    expect(launched[0]?.status).toBe('running')
    expect(launched[0]?.executionStack?.[1]?.status).toBe('pending')

    // The host stops declaring the next workflow: the advance cannot be
    // mapped, so the launch is refused.
    workflows.splice(1, 1)

    const wfHook = sim.calls.hook.find((h) => h.h === 'workflow.execution.changed')!.fn
    await wfHook({
      event: 'workflow.execution.changed',
      timestamp: new Date().toISOString(),
      sessionId: launched[0]?.sessionId,
      data: {
        executionId: 'exec-1',
        workflowId: 'plan-issue-v3',
        workflowName: 'plan-issue-v3',
        status: 'completed',
      },
    })
    await settle()

    const after = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
    const cp = readJson<{ items: Record<string, { status: string; error?: string }> }>(
      sim.backing,
      'control_plane',
    )
    // Blocked in BOTH views, with the same reason — not a silent 'running'.
    expect(after[0]?.status).toBe('blocked')
    expect(cp?.items['acme/widgets#1']?.status).toBe('blocked')
    expect(after[0]?.error).toContain('could not start workflow build-verify-v3')
    expect(cp?.items['acme/widgets#1']?.error).toContain('could not start workflow build-verify-v3')
    // The step that could not start is not left 'running' under a blocked
    // issue.
    expect(after[0]?.executionStack?.[1]?.status).not.toBe('running')
  })

  it('a QUEUED launch is NOT a failure: the issue stays running', async () => {
    // The host's slots are already held by OTHER work: the plugin's launch
    // is QUEUED, not refused. The host accepted the task and runs it as
    // soon as a slot frees, so blocking the issue would orphan the run —
    // when it eventually starts, its workflow.execution.changed event
    // would find no active entry and be dropped.
    const sim = makeFaithfulSim({
      issues: [{ number: 1, title: 'I1' }],
      chain: ['plan-issue-v3'],
    })
    // The plugin raises the host's slot limit to its own worker count
    // (three by default), so three tasks already in progress exhaust it.
    for (let i = 0; i < 5; i += 1) {
      sim.tasks.push({
        id: `manual-${i}`,
        prompt: '',
        state: 'in_progress',
        runState: 'running',
        workflowId: '',
      })
    }
    register(sim.registry)
    await settle()
    await sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!.fn({}, sim.registry.context)
    await sim.calls.rpc.find((r) => r.name === 'automate.controlPlaneSchedule')!.fn({}, sim.registry.context)
    await settle()

    // The host REALLY queued the launch, so the scenario under test
    // actually happened.
    expect(sim.tasks.some((t) => t.workflowId === 'plan-issue-v3' && t.runState === 'queued')).toBe(true)
    const queue = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
    const cp = readJson<{ items: Record<string, { status: string; error?: string }> }>(
      sim.backing,
      'control_plane',
    )
    expect(queue).toHaveLength(1)
    // NOT blocked, in EITHER view: a queued launch is not a refusal.
    expect(queue[0]?.status).toBe('running')
    expect(queue[0]?.error).toBeFalsy()
    expect(cp?.items['acme/widgets#1']?.status).toBe('running')
    expect(cp?.items['acme/widgets#1']?.error).toBeFalsy()
  })

  it('the CALLER sees the refusal: startIssue returns the blocked entry', async () => {
    // The refusal is recorded while the launch is still in flight. If the
    // caller kept the stale 'running' object it built before the launch,
    // it would believe the issue started and keep the reservation.
    const sim = makeFaithfulSim({
      issues: [{ number: 1, title: 'I1' }],
      chain: ['plan-issue-v3'],
      workflows: [],
    })
    register(sim.registry)
    await settle()
    await sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!.fn({}, sim.registry.context)

    const queued = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
    expect(queued[0]?.status).toBe('queued')

    const started = (await sim.calls.rpc
      .find((r) => r.name === 'automate.startIssue')!
      .fn({ queueId: queued[0]!.id }, sim.registry.context)) as QueueEntry

    // The RETURNED entry reports the refusal — not a stale 'running'.
    expect(started.status).toBe('blocked')
    expect(started.error).toContain('could not start workflow plan-issue-v3')

    // And the two views still agree: the refusal is not overwritten by
    // 'failed' on the way out.
    const status = (await sim.calls.rpc
      .find((r) => r.name === 'automate.controlPlaneStatus')!
      .fn({}, sim.registry.context)) as { divergences: string[] }
    expect(status.divergences).toEqual([])
  })
})
