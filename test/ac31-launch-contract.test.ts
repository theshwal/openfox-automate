/**
 * AC31 — Adversarial tests for the LAUNCH path against the real OpenFox
 * 2.0.161 contract.
 *
 * Three defects were reported:
 *
 *  #19 (HIGH) — the chain could not continue an EXISTING session past
 *        step 1: the host's `reusableTarget` only reuses a session that has
 *        NO MESSAGES, so the host seeds a new one and the plugin (which
 *        looked the entry up by its own session id) ignored its events.
 * #20 (HIGH) — the launch dropped the issue CONTENT and mis-mapped the
 *        parameters: the host maps them by DECLARED position and refuses
 *        the launch when a required one is missing.
 *  #21 (CRITICAL) — the task was never closed, so the host's worker slot
 *        was consumed forever and the second issue never started.
 *
 * Every test drives the PUBLIC path (the plugin's RPCs and hooks) with a
 * fake host that reproduces the host's real answers.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { _resetLifecycleForTesting, register } from '../src/index.js'
import { makeSim, readJson, rpc, settle } from './helpers/sim.js'
import type { QueueEntry } from '../src/types.js'

const CHAIN = ['plan-issue-v3', 'build-verify-v3', 'publish-pr-v1']

afterEach(() => {
  _resetLifecycleForTesting()
  vi.unstubAllGlobals()
})

describe('AC31 #20 — the parameters and the content reach the workflow', () => {
  it('sends the arguments in the DECLARED order and keeps the issue context', async () => {
    const sim = makeSim({
      issues: [{ number: 7, title: 'Widget explodes', body: 'It crashes on startup.' }],
      chain: CHAIN,
    })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)
    await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)
    await settle()

    const taskCall = sim.hostCalls.find((c) => c.method === 'POST' && c.url.endsWith('/tasks'))
    expect(taskCall).toBeDefined()
    const prompt = (taskCall?.body as { prompt: string }).prompt

    // The arguments come FIRST, in the declared order (issue_ref, then
    // repo) — the host maps them by position.
    expect(prompt.startsWith('/plan-issue-v3 ')).toBe(true)
    expect(prompt).toContain('acme/widgets#7')

    // And the issue CONTEXT is not lost: the host only ever sees the
    // prompt, so the body must travel with it.
    expect(prompt).toContain('It crashes on startup.')
    expect(prompt).toContain('Widget explodes')
  })

  it('reads the declared parameter order from the host before building the prompt', async () => {
    const sim = makeSim({ issues: [{ number: 7, title: 'I7' }], chain: CHAIN })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)
    await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)
    await settle()

    // The workflow metadata is read FIRST: the host refuses a launch whose
    // required parameter is missing.
    const workflowsIndex = sim.hostCalls.findIndex((c) => c.url.endsWith('/api/workflows'))
    const taskIndex = sim.hostCalls.findIndex((c) => c.method === 'POST' && c.url.endsWith('/tasks'))
    expect(workflowsIndex).toBeGreaterThanOrEqual(0)
    expect(workflowsIndex).toBeLessThan(taskIndex)
  })
})

describe('AC31 #21 — the host task is closed, the slot is freed', () => {
  it('raises the host slot limit to the plugin capacity', async () => {
    const sim = makeSim({ issues: [{ number: 7, title: 'I7' }], chain: CHAIN })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)
    await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)
    await settle()

    // The host defaults to ONE task per project, which would serialise
    // the plugin's workers.
    const settingsCall = sim.hostCalls.find((c) => c.method === 'PUT' && c.url.endsWith('/tasks/settings'))
    expect(settingsCall).toBeDefined()
    expect(settingsCall?.body).toEqual({ slotLimit: 5 })
  })

  it('closes the task when the chain completes, so the next issue can start', async () => {
    const sim = makeSim({ issues: [{ number: 7, title: 'I7' }], chain: CHAIN })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)
    await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)
    await settle()

    const wfHook = sim.calls.hook.find((h) => h.h === 'workflow.execution.changed')!.fn
    for (const step of CHAIN) {
      await wfHook({
        event: 'workflow.execution.changed',
        timestamp: new Date().toISOString(),
        sessionId: sim.sessions[sim.sessions.length - 1]!,
        data: {
          executionId: `exec-${step}`,
          workflowId: step,
          workflowName: step,
          status: 'completed',
        },
      })
    }
    await settle()

    // The task was moved to 'done': the host frees its worker slot.
    const closeCall = sim.hostCalls.find(
      (c) => c.method === 'POST' && c.url.includes('/move') && (c.body as { to?: string })?.to === 'done',
    )
    expect(closeCall).toBeDefined()

    // And the issue is done in both views.
    const history = readJson<QueueEntry[]>(sim.backing, 'history') ?? []
    expect(history).toHaveLength(1)
    expect(history[0]?.status).toBe('done')
  })

  it('deletes the task when the issue is cancelled', async () => {
    const sim = makeSim({ issues: [{ number: 7, title: 'I7' }], chain: CHAIN })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)
    await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)
    await settle()

    const queue = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
    await rpc(sim, 'automate.cancelIssue')({ queueId: queue[0]!.id }, sim.registry.context)
    await settle()

    const deleteCall = sim.hostCalls.find((c) => c.method === 'DELETE' && c.url.includes('/tasks/'))
    expect(deleteCall).toBeDefined()
  })
})

describe('AC31 #19 — the chain follows the session the host reports', () => {
  it('records the host session, so the host events are matched to the entry', async () => {
    const sim = makeSim({ issues: [{ number: 7, title: 'I7' }], chain: CHAIN })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)
    await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)
    await settle()

    const queue = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
    // The entry is bound to the session the HOST reported.
    expect(queue[0]?.sessionId).toBe('sess-1')
    // And the host task is recorded, so it can be closed.
    expect(queue[0]?.hostTaskId).toBe('task-1')
  })
})
