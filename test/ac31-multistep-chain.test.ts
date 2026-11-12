/**
 * AC31 (second review round) — regression tests for the THREE defects
 * the independent re-verification found at HEAD b0639d7.
 *
 *  #19 (CRITICAL) — only the FIRST chain step followed the host session.
 *        The chain advance re-launched the next step WITHOUT awaiting the
 *        outcome, so the session the host seeded was never persisted: the
 *        entry stayed on the old session and the host's event for step 2
 *        was dropped by the hook (which looks the entry up by session id).
 *        The chain stalled after step 1.
 *
 *  #21 (CRITICAL) — the host tasks of the INTERMEDIATE steps were never
 *        closed. The host only frees a worker slot when its task leaves
 *        "in_progress", so the dead tasks consumed the host's slots
 *        forever: after a few issues the host queued every new task and
 *        no workflow ever started again.
 *
 *  #25 — `automate.startIssue` revived a control-plane item that was
 *        'failed' / 'cancelled' / 'blocked', keeping its stale error
 *        while the run started again.
 *
 * These tests run against the FAITHFUL host model
 * (`test/helpers/faithful-host.ts`), which reproduces the three host
 * behaviours that broke the launch path:
 *
 *   - `reusableTarget` only reuses a session that has NO MESSAGES, so the
 *     host seeds a NEW session for every step and reports it;
 *   - a task only frees its slot when it leaves "in_progress";
 *   - the host QUEUES a task when its slot limit is reached.
 *
 * Everything is offline: no server, no port, no network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { _resetLifecycleForTesting, register } from '../src/index.js'
import { makeFaithfulSim, readJson, settle } from './helpers/faithful-host.js'
import type { QueueEntry } from '../src/types.js'

const CHAIN = ['plan-issue-v3', 'build-verify-v3', 'publish-pr-v1']

interface Hook {
  h: string
  fn: (p: unknown) => Promise<void>
}

afterEach(() => {
  _resetLifecycleForTesting()
  vi.unstubAllGlobals()
})

function hookOf(hooks: Hook[], name: string): (p: unknown) => Promise<void> {
  const found = hooks.find((h) => h.h === name)
  if (!found) throw new Error(`hook not registered: ${name}`)
  return found.fn
}

function rpcOf(
  rpcs: Array<{ name: string; fn: (p: unknown, c: unknown) => Promise<unknown> }>,
  name: string,
): (p: unknown, c: unknown) => Promise<unknown> {
  const found = rpcs.find((r) => r.name === name)
  if (!found) throw new Error(`the RPC "${name}" is not registered`)
  return found.fn
}

/**
 * Send the `completed` event of a workflow on the session the ENTRY
 * currently uses.
 *
 * The host reports the session it actually bound the run to, so the event
 * must be sent on that session: that is exactly what the real host does.
 */
async function completeStep(
  sim: ReturnType<typeof makeFaithfulSim>,
  issueNumber: number,
  workflowId: string,
): Promise<void> {
  await settle()
  const queue = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
  const entry = queue.find((e) => e.issueNumber === issueNumber)
  await hookOf(
    sim.calls.hook,
    'workflow.execution.changed',
  )({
    event: 'workflow.execution.changed',
    timestamp: new Date().toISOString(),
    sessionId: entry?.sessionId,
    data: {
      executionId: `exec-${issueNumber}-${workflowId}`,
      workflowId,
      workflowName: workflowId,
      status: 'completed',
    },
  })
  await settle()
}

describe('AC31 #19 — EVERY chain step follows the session the host reports', () => {
  it('the entry follows the session at each step, so the chain reaches "done"', async () => {
    const sim = makeFaithfulSim({ issues: [{ number: 7, title: 'I7' }], chain: CHAIN })
    register(sim.registry)
    await settle()
    await rpcOf(sim.calls.rpc, 'automate.scanNow')({}, sim.registry.context)
    await rpcOf(sim.calls.rpc, 'automate.controlPlaneSchedule')({}, sim.registry.context)
    await settle()

    // The first step ran in the session the plugin created.
    const firstSession = (readJson<QueueEntry[]>(sim.backing, 'queue') ?? [])[0]?.sessionId
    expect(firstSession).toBeTruthy()

    // The host seeds a NEW session for the second step: it can only reuse
    // a session that has no messages.
    await completeStep(sim, 7, 'plan-issue-v3')
    const afterFirst = (readJson<QueueEntry[]>(sim.backing, 'queue') ?? [])[0]
    expect(afterFirst?.executionStack?.[0]?.status).toBe('done')
    expect(afterFirst?.executionStack?.[1]?.status).toBe('running')
    // The entry followed the session the HOST reported.
    expect(afterFirst?.sessionId).not.toBe(firstSession)

    // The third step: the session changes again, and the entry follows.
    await completeStep(sim, 7, 'build-verify-v3')
    const afterSecond = (readJson<QueueEntry[]>(sim.backing, 'queue') ?? [])[0]
    expect(afterSecond?.executionStack?.[1]?.status).toBe('done')
    expect(afterSecond?.executionStack?.[2]?.status).toBe('running')
    expect(afterSecond?.sessionId).not.toBe(afterFirst?.sessionId)

    // The last step: the issue is done. The chain did NOT stall after
    // step 1 — that was the defect.
    await completeStep(sim, 7, 'publish-pr-v1')
    const history = readJson<QueueEntry[]>(sim.backing, 'history') ?? []
    expect(history).toHaveLength(1)
    expect(history[0]?.status).toBe('done')
    expect(history[0]?.executionStack?.every((s) => s.status === 'done')).toBe(true)
  })

  it('the control plane knows the same session as the queue (no drift)', async () => {
    const sim = makeFaithfulSim({ issues: [{ number: 7, title: 'I7' }], chain: CHAIN })
    register(sim.registry)
    await settle()
    await rpcOf(sim.calls.rpc, 'automate.scanNow')({}, sim.registry.context)
    await rpcOf(sim.calls.rpc, 'automate.controlPlaneSchedule')({}, sim.registry.context)
    await settle()
    await completeStep(sim, 7, 'plan-issue-v3')

    const cp = readJson<{ items: Record<string, { sessionId?: string; status: string }> }>(
      sim.backing,
      'control_plane',
    )
    const queue = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
    expect(cp?.items['acme/widgets#7']?.sessionId).toBe(queue[0]?.sessionId)

    const status = (await rpcOf(sim.calls.rpc, 'automate.controlPlaneStatus')({}, sim.registry.context)) as {
      divergences: string[]
    }
    expect(status.divergences).toEqual([])
  })
})

describe('AC31 #21 — EVERY host task is closed, so the host slots are released', () => {
  it('closes the task of EVERY step, not only the first one', async () => {
    const sim = makeFaithfulSim({ issues: [{ number: 7, title: 'I7' }], chain: CHAIN })
    register(sim.registry)
    await settle()
    await rpcOf(sim.calls.rpc, 'automate.scanNow')({}, sim.registry.context)
    await rpcOf(sim.calls.rpc, 'automate.controlPlaneSchedule')({}, sim.registry.context)
    await settle()

    await completeStep(sim, 7, 'plan-issue-v3')
    await completeStep(sim, 7, 'build-verify-v3')
    await completeStep(sim, 7, 'publish-pr-v1')

    // One task per step: three of them.
    expect(sim.tasks).toHaveLength(3)
    // And NONE of them is still holding a host slot.
    expect(sim.activeTaskCount()).toBe(0)
    for (const task of sim.tasks) {
      expect(task.state).toBe('done')
    }
  })

  it('the host slots are released, so the NEXT issue still starts', async () => {
    // THE DEFECT: with the intermediate tasks left in_progress, the host's
    // slots saturate and the next issue's task stays QUEUED forever — the
    // plugin believes it is running, but the workflow never starts.
    //
    // The host is given ONE slot, so a dead task really does block the
    // next one.
    const sim = makeFaithfulSim({
      issues: [
        { number: 1, title: 'I1' },
        { number: 2, title: 'I2' },
      ],
      chain: CHAIN,
      slotLimit: 1,
    })
    register(sim.registry)
    await settle()
    await rpcOf(sim.calls.rpc, 'automate.scanNow')({}, sim.registry.context)
    await rpcOf(sim.calls.rpc, 'automate.controlPlaneSchedule')({}, sim.registry.context)
    await settle()

    // The plugin asks for the capacity it needs; the host honours it.
    // The scenario below forces the host back to ONE slot so a dead task
    // really blocks the next issue.
    const settingsCall = sim.hostCalls.find((c) => c.url.endsWith('/tasks/settings'))
    expect(settingsCall).toBeDefined()

    // The first issue runs its three steps.
    await completeStep(sim, 1, 'plan-issue-v3')
    await completeStep(sim, 1, 'build-verify-v3')
    await completeStep(sim, 1, 'publish-pr-v1')

    // Every task of the FIRST issue is closed: none of them holds a host
    // slot any more. That is the property the defect broke.
    const firstIssueTasks = sim.tasks.filter((t) => t.prompt.includes('acme/widgets#1'))
    expect(firstIssueTasks).toHaveLength(3)
    for (const task of firstIssueTasks) {
      expect(task.state).toBe('done')
    }

    // The second issue starts AND its workflow actually RUNS on the host
    // (runState is 'running', not 'queued'): the slots were released.
    await settle()
    await rpcOf(sim.calls.rpc, 'automate.controlPlaneSchedule')({}, sim.registry.context)
    await settle()

    const second = sim.tasks.filter((t) => t.prompt.includes('acme/widgets#2'))
    expect(second.length).toBeGreaterThan(0)
    for (const task of second) {
      expect(task.runState).toBe('running')
    }
  })
})

describe('AC31 #25 — a finished issue is never revived by startIssue', () => {
  it('refuses to start an issue whose control-plane item failed', async () => {
    const sim = makeFaithfulSim({ issues: [{ number: 7, title: 'I7' }], chain: CHAIN })
    register(sim.registry)
    await settle()
    await rpcOf(sim.calls.rpc, 'automate.scanNow')({}, sim.registry.context)
    await settle()

    // The control plane knows the issue, and it FAILED.
    const cp = readJson<{
      items: Record<string, { status: string; error?: string }>
    }>(sim.backing, 'control_plane')
    expect(cp?.items['acme/widgets#7']).toBeDefined()
    cp!.items['acme/widgets#7']!.status = 'failed'
    cp!.items['acme/widgets#7']!.error = 'previous run failed'
    sim.backing.set('control_plane', JSON.stringify(cp))

    // The legacy entry is still 'queued' — the trap the finding describes.
    const queue = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
    expect(queue[0]?.status).toBe('queued')

    await expect(
      rpcOf(sim.calls.rpc, 'automate.startIssue')({ queueId: queue[0]!.id }, sim.registry.context),
    ).rejects.toThrow(/failed/)

    // No session was created: the item was not revived.
    expect(sim.sessions).toHaveLength(0)
    const after = readJson<{
      items: Record<string, { status: string }>
    }>(sim.backing, 'control_plane')
    expect(after?.items['acme/widgets#7']?.status).toBe('failed')
  })

  it('refuses to start an issue whose control-plane item was cancelled or blocked', async () => {
    for (const status of ['cancelled', 'blocked'] as const) {
      const sim = makeFaithfulSim({ issues: [{ number: 7, title: 'I7' }], chain: CHAIN })
      register(sim.registry)
      await settle()
      await rpcOf(sim.calls.rpc, 'automate.scanNow')({}, sim.registry.context)
      await settle()

      const cp = readJson<{ items: Record<string, { status: string; error?: string }> }>(
        sim.backing,
        'control_plane',
      )
      cp!.items['acme/widgets#7']!.status = status
      cp!.items['acme/widgets#7']!.error = `previous run ${status}`
      sim.backing.set('control_plane', JSON.stringify(cp))

      const queue = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
      await expect(
        rpcOf(sim.calls.rpc, 'automate.startIssue')({ queueId: queue[0]!.id }, sim.registry.context),
      ).rejects.toThrow(new RegExp(status))
      expect(sim.sessions).toHaveLength(0)

      _resetLifecycleForTesting()
      vi.unstubAllGlobals()
    }
  })

  it('the explicit reprocess still works — that is the supported way to run it again', async () => {
    const sim = makeFaithfulSim({ issues: [{ number: 7, title: 'I7' }], chain: CHAIN })
    register(sim.registry)
    await settle()
    await rpcOf(sim.calls.rpc, 'automate.scanNow')({}, sim.registry.context)
    await settle()

    // The control plane knows the issue, and it FAILED; the legacy entry
    // is 'blocked' — the state the reprocess path accepts.
    const cp = readJson<{ items: Record<string, { status: string; error?: string }> }>(
      sim.backing,
      'control_plane',
    )
    cp!.items['acme/widgets#7']!.status = 'failed'
    cp!.items['acme/widgets#7']!.error = 'previous run failed'
    sim.backing.set('control_plane', JSON.stringify(cp))

    const queue = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
    queue[0]!.status = 'blocked'
    sim.backing.set('queue', JSON.stringify(queue))

    await rpcOf(sim.calls.rpc, 'automate.reprocess')({ queueId: queue[0]!.id }, sim.registry.context)
    await settle()

    // The issue is schedulable again.
    const after = readJson<{ items: Record<string, { status: string; error?: string }> }>(
      sim.backing,
      'control_plane',
    )
    expect(after?.items['acme/widgets#7']?.status).not.toBe('failed')
  })
})
