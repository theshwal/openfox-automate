/**
 * AC32 — finding #20: the parameters the host ACTUALLY interprets.
 *
 * The defect was that the plugin's tests asserted the PROMPT it built,
 * never what the host DERIVES from that prompt. The host splits the
 * prompt on every whitespace and maps the tokens onto the declared
 * parameters BY POSITION, and it drops the prompt entirely when it
 * launches the workflow.
 *
 * These tests therefore run the plugin's output through the host's OWN
 * parser (`test/helpers/host-parser.ts`, a faithful transcription of
 * OpenFox 2.0.161 `parseSlashInvocation` + `workflowParamsFromArgs` +
 * `resolveSlashLaunch`) and assert the RESULTING PARAMETERS.
 *
 * The declared parameters are the REAL ones of this machine, read from
 * the installed host's workflow definitions:
 *
 *   plan-issue-v3   → issue_ref (position 0, REQUIRED), repo (position 1)
 *   build-verify-v3 → workdir (position 0)
 *   publish-pr-v1   → workdir (position 0)
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { _resetLifecycleForTesting, register } from '../src/index.js'
import { buildWorkflowLaunchMessage } from '../src/host-client.js'
import { mapDeclaredParameters } from '../src/parameter-mapping.js'
import { realWorkflow, resolveSlashLaunch } from './helpers/host-parser.js'
import { makeSim, rpc, settle } from './helpers/sim.js'

afterEach(() => {
  _resetLifecycleForTesting()
  vi.unstubAllGlobals()
})

describe('AC32 #20 — the parameters the host really interprets', () => {
  it('plan-issue-v3 receives issue_ref and repo, and nothing else', () => {
    const available = { issue_ref: 'acme/widgets#7', repo: 'acme/widgets' }
    const mapping = mapDeclaredParameters(realWorkflow('plan-issue-v3').parameters, available)
    expect(mapping.ok).toBe(true)
    if (!mapping.ok) return

    const prompt = buildWorkflowLaunchMessage('plan-issue-v3', mapping.params, mapping.values)
    const resolved = resolveSlashLaunch(realWorkflow('plan-issue-v3'), prompt)

    // The host did NOT refuse the launch, and the parameters are the
    // ones the workflow declares.
    expect(resolved).not.toBeNull()
    expect(resolved?.params).toEqual({
      issue_ref: 'acme/widgets#7',
      repo: 'acme/widgets',
    })
  })

  it('the planner gets a REPO it can read the issue with', () => {
    // `plan-issue-v3` runs `gh issue view "$num" -R "$repo"`: a `repo`
    // that is not `owner/name` makes the planner fail with
    // "TARGET REJECTED" and the workflow never starts.
    const available = { issue_ref: 'acme/widgets#7', repo: 'acme/widgets' }
    const mapping = mapDeclaredParameters(realWorkflow('plan-issue-v3').parameters, available)
    if (!mapping.ok) throw new Error('the mapping must succeed')
    const prompt = buildWorkflowLaunchMessage('plan-issue-v3', mapping.params, mapping.values)
    const resolved = resolveSlashLaunch(realWorkflow('plan-issue-v3'), prompt)
    expect(resolved?.params['repo']).toBe('acme/widgets')
    // And the reference still carries the repo, so the planner can split
    // it into repo + number itself.
    expect(resolved?.params['issue_ref']).toBe('acme/widgets#7')
  })

  it('build-verify-v3 and publish-pr-v1 receive NO argument when the workdir is unknown', () => {
    // `workdir` is optional and is the LAST declared position: leaving it
    // out keeps the positional mapping intact, and the host resolves
    // `{{workdir}}` from the SESSION anyway.
    for (const id of ['build-verify-v3', 'publish-pr-v1']) {
      const mapping = mapDeclaredParameters(realWorkflow(id).parameters, {
        issue_ref: 'acme/widgets#7',
        repo: 'acme/widgets',
      })
      expect(mapping.ok).toBe(true)
      if (!mapping.ok) return
      const prompt = buildWorkflowLaunchMessage(id, mapping.params, mapping.values)
      const resolved = resolveSlashLaunch(realWorkflow(id), prompt)
      expect(resolved).not.toBeNull()
      expect(resolved?.params).toEqual({})
    }
  })

  it('NO free text follows the arguments: the prompt has a single line', () => {
    const mapping = mapDeclaredParameters(realWorkflow('plan-issue-v3').parameters, {
      issue_ref: 'acme/widgets#7',
      repo: 'acme/widgets',
    })
    if (!mapping.ok) throw new Error('the mapping must succeed')
    const prompt = buildWorkflowLaunchMessage('plan-issue-v3', mapping.params, mapping.values)
    expect(prompt).toBe('/plan-issue-v3 acme/widgets#7 acme/widgets')
    // A newline would be split by the host and would land in the NEXT
    // positional parameter.
    expect(prompt.includes('\n')).toBe(false)
    expect(prompt.split(/\s+/)).toHaveLength(3)
  })

  it('the launch is REFUSED when the declared parameters cannot be read', () => {
    // FAIL-CLOSED: guessing the order from `Object.keys()` is what put
    // an issue URL in the `repo` parameter.
    const mapping = mapDeclaredParameters(null, {
      issue_ref: 'acme/widgets#7',
      issue_url: 'https://github.com/acme/widgets/issues/7',
    })
    expect(mapping.ok).toBe(false)
    if (mapping.ok) return
    expect(mapping.reason).toBe('discovery-failed')
  })

  it('the launch is REFUSED when a REQUIRED parameter has no value', () => {
    const mapping = mapDeclaredParameters(realWorkflow('plan-issue-v3').parameters, {
      repo: 'acme/widgets',
    })
    expect(mapping.ok).toBe(false)
    if (mapping.ok) return
    expect(mapping.reason).toBe('missing-required')
    expect(mapping.missing).toContain('issue_ref')
  })

  it('a gap in the middle is REFUSED: it would shift the next parameter', () => {
    // The host maps `args[index]`, so a value that is not sent leaves a
    // hole and the NEXT parameter slides into it.
    const mapping = mapDeclaredParameters(
      [
        { id: 'issue_ref', position: 0, required: true },
        { id: 'repo', position: 1, required: false },
        { id: 'extra', position: 2, required: false },
      ],
      { issue_ref: 'acme/widgets#7' },
    )
    expect(mapping.ok).toBe(false)
    if (mapping.ok) return
    expect(mapping.missing).toContain('repo')
  })
})

describe('AC32 #20 — end to end through the plugin', () => {
  it('the prompt the plugin submits yields the expected host parameters', async () => {
    const sim = makeSim({
      issues: [{ number: 7, title: 'Widget explodes', body: 'It crashes on startup.' }],
      chain: ['plan-issue-v3'],
    })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)
    await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)
    await settle()

    const taskCall = sim.hostCalls.find((c) => c.method === 'POST' && c.url.endsWith('/tasks'))
    expect(taskCall).toBeDefined()
    const prompt = (taskCall?.body as { prompt: string }).prompt

    // What the host derives from that prompt.
    const resolved = resolveSlashLaunch(realWorkflow('plan-issue-v3'), prompt)
    expect(resolved).not.toBeNull()
    expect(resolved?.params).toEqual({
      issue_ref: 'acme/widgets#7',
      repo: 'acme/widgets',
    })
    // The issue body is NOT in the prompt: the planner re-reads the issue
    // with an authenticated `gh`, and any free text would corrupt the
    // positional mapping.
    expect(prompt).not.toContain('It crashes on startup.')
  })

  it('the chain still advances on the same session and the slots are freed', async () => {
    // The protocol change must not break the chain: the same session is
    // reused for the first step, the host's events still drive the
    // advance, and the host task is closed at the end.
    const sim = makeSim({
      issues: [{ number: 7, title: 'I7' }],
      chain: ['plan-issue-v3', 'build-verify-v3', 'publish-pr-v1'],
    })
    register(sim.registry)
    await settle()
    await rpc(sim, 'automate.scanNow')({}, sim.registry.context)
    await rpc(sim, 'automate.controlPlaneSchedule')({}, sim.registry.context)
    await settle()

    const wfHook = sim.calls.hook.find((h) => h.h === 'workflow.execution.changed')!.fn
    for (const step of ['plan-issue-v3', 'build-verify-v3', 'publish-pr-v1']) {
      const queue = (await rpc(sim, 'automate.getQueue')({}, sim.registry.context)) as Array<{
        sessionId?: string
      }>
      await wfHook({
        event: 'workflow.execution.changed',
        timestamp: new Date().toISOString(),
        sessionId: queue[0]?.sessionId,
        data: {
          executionId: `exec-${step}`,
          workflowId: step,
          workflowName: step,
          status: 'completed',
        },
      })
      await settle()
    }

    const history = (await rpc(sim, 'automate.getHistory')({}, sim.registry.context)) as Array<{
      status: string
    }>
    expect(history).toHaveLength(1)
    expect(history[0]?.status).toBe('done')
    // Every host task was closed: the host's slots are free.
    const closeCalls = sim.hostCalls.filter(
      (c) => c.method === 'POST' && c.url.includes('/move') && (c.body as { to?: string })?.to === 'done',
    )
    expect(closeCalls.length).toBe(3)
  })
})
