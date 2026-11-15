/**
 * AC10 — Vertical simulation of the whole flow.
 *
 * The scenario:
 *
 *   fake GitHub issue
 *     -> qualification (ignore labels / dedup / ordering)
 *     -> reservation (concurrency limits)
 *     -> mocked session creation
 *     -> workflow launched
 *     -> host `workflow.execution.changed` (completed)
 *     -> next step of the chain launched
 *     -> PR URL captured
 *     -> simulated CI reconciled
 *
 * Everything is deterministic and offline:
 *
 *   - GitHub is a local fake (`fetch` stub) — no network, no real repo.
 *   - The host is a local fake — no OpenFox server, no port, no session.
 *   - No VisiPdP (or any other) session is involved: sessions are
 *     synthetic ids created by the fake.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { _resetLifecycleForTesting, register } from '../src/index.js'
import { monitorPRs } from '../src/pr-monitor.js'
import { makeSim, readJson, rpc, settle } from './helpers/sim.js'
import type { QueueEntry } from '../src/types.js'

const CHAIN = ['plan-issue-v3', 'build-verify-v3', 'publish-pr-v1']

const ISSUES = [
  {
    number: 7,
    title: 'Widget explodes',
    body: 'The widget crashes on startup.',
    labels: ['bug'],
  },
  { number: 8, title: 'Ignored issue', body: '', labels: ['wontfix'] },
]

function hostWorkflowEvent(
  sessionId: string,
  data: { executionId: string; workflowId: string; status: string },
): Record<string, unknown> {
  return {
    event: 'workflow.execution.changed',
    timestamp: new Date().toISOString(),
    sessionId,
    data: { ...data, workflowName: data.workflowId },
  }
}

afterEach(() => {
  _resetLifecycleForTesting()
  vi.unstubAllGlobals()
})

describe('AC10 — vertical simulation (no network, no host process)', () => {
  it('runs issue → qualification → reservation → session → workflow → next step → PR → CI', async () => {
    const sim = makeSim({
      issues: ISSUES,
      chain: CHAIN,
      inProcessFacade: true,
      settings: {
        'github.token': 'test-token',
        'scan.ignoreLabels': 'wontfix',
        'ordering.dependencyPattern': '(#(\\d+))',
        'pr.monitorEnabled': true,
        'pr.urlRegex': 'https://github\\.com/[^/]+/[^/]+/pull/(\\d+)',
      },
    })

    register(sim.registry)
    await settle()

    // ---- 1. qualification: scan GitHub ----
    const scanResult = (await rpc(sim, 'automate.scanNow')({}, sim.registry.context)) as {
      added: number
      skipped: number
      errors: string[]
    }
    expect(scanResult.errors).toEqual([])
    // The 'wontfix' issue is filtered out by the ignore-label rule.
    expect(scanResult.added).toBe(1)

    const queued = readJson<QueueEntry[]>(sim.backing, 'queue')!
    expect(queued).toHaveLength(1)
    expect(queued[0]?.issueNumber).toBe(7)
    expect(queued[0]?.status).toBe('queued')

    // ---- 2. reservation: the entry gets a session and the first workflow ----
    await rpc(sim, 'automate.startIssue')({ queueId: queued[0]!.id }, sim.registry.context)
    await settle()

    expect(sim.inProcessLaunches).toHaveLength(1)
    expect(sim.inProcessLaunches[0]?.workflowId).toBe('plan-issue-v3')
    expect(sim.inProcessLaunches[0]?.sessionId).toBe('sess-1')

    const running = readJson<QueueEntry[]>(sim.backing, 'queue')!
    expect(running[0]?.status).toBe('running')
    expect(running[0]?.sessionId).toBe('sess-1')
    expect(running[0]?.executionStack?.[0]?.status).toBe('running')

    // ---- 3. the host reports the first workflow completed ----
    const wfHook = sim.calls.hook.find((h) => h.h === 'workflow.execution.changed')!.fn
    await wfHook(
      hostWorkflowEvent('sess-1', {
        executionId: 'exec-1',
        workflowId: 'plan-issue-v3',
        status: 'completed',
      }),
    )
    await settle()

    // The chain advanced: exactly ONE new launch, for the next step.
    expect(sim.inProcessLaunches).toHaveLength(2)
    expect(sim.inProcessLaunches[1]?.workflowId).toBe('build-verify-v3')

    const afterFirst = readJson<QueueEntry[]>(sim.backing, 'queue')!
    expect(afterFirst[0]?.executionStack?.[0]?.status).toBe('done')
    expect(afterFirst[0]?.executionStack?.[1]?.status).toBe('running')

    // ---- 4. idempotence: replaying the same event launches nothing ----
    await wfHook(
      hostWorkflowEvent('sess-1', {
        executionId: 'exec-1',
        workflowId: 'plan-issue-v3',
        status: 'completed',
      }),
    )
    await settle()
    expect(sim.inProcessLaunches).toHaveLength(2)

    // ---- 5. second step completes, third step launches ----
    await wfHook(
      hostWorkflowEvent('sess-1', {
        executionId: 'exec-2',
        workflowId: 'build-verify-v3',
        status: 'completed',
      }),
    )
    await settle()
    expect(sim.inProcessLaunches).toHaveLength(3)
    expect(sim.inProcessLaunches[2]?.workflowId).toBe('publish-pr-v1')

    // ---- 6. PR URL captured from the tool output ----
    const toolHook = sim.calls.hook.find((h) => h.h === 'tool.completed')!.fn
    await toolHook({
      event: 'tool.completed',
      timestamp: new Date().toISOString(),
      sessionId: 'sess-1',
      data: {
        messageId: 'm1',
        toolCallId: 'c1',
        result: {
          success: true,
          output: 'PR opened at https://github.com/acme/widgets/pull/42',
          durationMs: 3,
          truncated: false,
        },
      },
    })
    const withPr = readJson<QueueEntry[]>(sim.backing, 'queue')!
    expect(withPr[0]?.prUrl).toBe('https://github.com/acme/widgets/pull/42')

    // ---- 7. the last workflow completes: the entry is done ----
    await wfHook(
      hostWorkflowEvent('sess-1', {
        executionId: 'exec-3',
        workflowId: 'publish-pr-v1',
        status: 'completed',
      }),
    )
    await settle()
    expect(readJson<QueueEntry[]>(sim.backing, 'queue')).toHaveLength(0)
    const history = readJson<QueueEntry[]>(sim.backing, 'history')!
    expect(history).toHaveLength(1)
    expect(history[0]?.status).toBe('done')
    expect(history[0]?.prUrl).toBe('https://github.com/acme/widgets/pull/42')

    // ---- 8. simulated CI reconciliation (PR mergeable, not merged yet) ----
    const prResult = await monitorPRs({
      token: 'test-token',
      store: {
        loadActive: async () => readJson<QueueEntry[]>(sim.backing, 'queue') ?? [],
        transitionTo: async () => {
          throw new Error('should not transition: the entry is already done')
        },
      } as never,
      notify: vi.fn(),
      republish: vi.fn(),
    })
    expect(prResult.checked).toBe(0)
  })

  it('fails closed when the host cannot create a session: the entry is failed, nothing is launched', async () => {
    const sim = makeSim({ issues: [], hostReachable: false })
    register(sim.registry)
    await settle()

    const added = (await rpc(sim, 'automate.addIssueRaw')(
      { repoKey: 'acme/widgets', title: 'Boom', body: '' },
      sim.registry.context,
    )) as QueueEntry

    await rpc(sim, 'automate.startIssue')({ queueId: added.id }, sim.registry.context)

    // Nothing was launched: the plugin must not pretend it spawned a session.
    expect(sim.launchedPrompts).toHaveLength(0)
    const entries = readJson<QueueEntry[]>(sim.backing, 'queue')!
    expect(entries[0]?.status).toBe('failed')
    expect(entries[0]?.error).toBeTruthy()
  })

  it('blocks (never "done") when the host cancels the execution', async () => {
    const sim = makeSim({ issues: [] })
    register(sim.registry)
    await settle()

    const added = (await rpc(sim, 'automate.addIssueRaw')(
      { repoKey: 'acme/widgets', title: 'Boom', body: '' },
      sim.registry.context,
    )) as QueueEntry
    await rpc(sim, 'automate.startIssue')({ queueId: added.id }, sim.registry.context)
    await settle()

    await sim.calls.hook
      .find((h) => h.h === 'workflow.execution.changed')!
      .fn(
        hostWorkflowEvent('sess-1', {
          executionId: 'exec-cancel',
          workflowId: 'plan-issue-v3',
          status: 'cancelled',
        }),
      )

    const entries = readJson<QueueEntry[]>(sim.backing, 'queue')!
    const history = readJson<QueueEntry[]>(sim.backing, 'history')!
    const entry = entries[0] ?? history[0]
    expect(entry?.status).toBe('blocked')
    expect(entry?.status).not.toBe('done')
    // No relaunch was attempted for a cancelled execution.
    expect(sim.launchedPrompts).toHaveLength(1)
  })

  it('respects the concurrency ceiling when several issues are queued', async () => {
    const sim = makeSim({
      issues: [{ number: 12, title: 'B' }],
      chain: CHAIN,
      settings: {
        'batch.maxConcurrency': 1,
        'batch.maxConcurrencyPerRepo': 1,
        'ordering.dependencyPattern': '',
        'pr.monitorEnabled': false,
      },
    })
    register(sim.registry)
    await settle()

    await rpc(sim, 'automate.addIssueRaw')(
      { repoKey: 'acme/widgets', title: 'A', body: '' },
      sim.registry.context,
    )
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)

    // The ceiling is 1, so the CONTROL PLANE owns the scheduling: it
    // reserves and starts exactly one issue. The legacy `startIssue` path
    // must then refuse the other one — that is the guarantee that a single
    // scheduler owns the queue.
    const scheduled = (await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)) as {
      started: number
    }
    expect(scheduled.started).toBe(1)

    // The second issue is still queued: the ceiling of 1 is respected.
    const entries = readJson<QueueEntry[]>(sim.backing, 'queue')!
    expect(entries.filter((e) => e.status === 'running')).toHaveLength(1)
    expect(entries.filter((e) => e.status === 'queued')).toHaveLength(1)

    // Asking the legacy path to start the queued one is refused: the
    // control plane already holds the only slot.
    const queuedEntry = entries.find((e) => e.status === 'queued')!
    await expect(
      rpc(sim, 'automate.startIssue')({ queueId: queuedEntry.id }, sim.registry.context),
    ).rejects.toThrow(/already reserved by the control plane/)
  })
})
