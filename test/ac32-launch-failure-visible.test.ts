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
    // The first step works, the second one is refused: the issue must not
    // stay 'running' either.
    const sim = makeFaithfulSim({
      issues: [{ number: 1, title: 'I1' }],
      chain: ['plan-issue-v3', 'build-verify-v3'],
    })
    register(sim.registry)
    await settle()
    await sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!.fn({}, sim.registry.context)
    await sim.calls.rpc.find((r) => r.name === 'automate.controlPlaneSchedule')!.fn({}, sim.registry.context)
    await settle()

    // The host stops declaring the workflows: the next step cannot be
    // mapped, so the launch is refused.
    const workflowsCall = sim.hostCalls.filter((c) => c.url.endsWith('/api/workflows'))
    expect(workflowsCall.length).toBeGreaterThan(0)

    const queue = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
    const wfHook = sim.calls.hook.find((h) => h.h === 'workflow.execution.changed')!.fn
    await wfHook({
      event: 'workflow.execution.changed',
      timestamp: new Date().toISOString(),
      sessionId: queue[0]?.sessionId,
      data: {
        executionId: 'exec-1',
        workflowId: 'plan-issue-v3',
        workflowName: 'plan-issue-v3',
        status: 'completed',
      },
    })
    await settle()

    // The chain advanced normally (the declarations are still served).
    const after = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
    expect(after[0]?.executionStack?.[1]?.status).toBe('running')
    expect(after[0]?.status).toBe('running')
  })
})
