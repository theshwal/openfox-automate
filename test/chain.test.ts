import { describe, expect, it, vi } from 'vitest'
import {
  applyExecutionEvent,
  buildIssueContext,
  buildIssueParams,
  initExecutionStack,
  startChain,
} from '../src/chain.js'
import type { QueueEntry } from '../src/types.js'

function entry(partial: Partial<QueueEntry>): QueueEntry {
  return {
    id: 'qe1',
    repoKey: 'o/r',
    projectId: 'p',
    issueNumber: 1,
    title: 'T',
    body: '',
    url: 'https://github.com/o/r/issues/1',
    labels: ['bug'],
    comments: [],
    dependsOn: [],
    status: 'running',
    position: 1,
    addedAt: '2024-01-01T00:00:00.000Z',
    startedAt: '2024-01-01T00:00:01.000Z',
    sessionId: 'sess1',
    executionStack: [
      { workflowId: 'Plan Issue v2', workflowName: 'Plan Issue v2', status: 'running', retryCount: 0 },
      {
        workflowId: 'Build & Verify Auto v2',
        workflowName: 'Build & Verify Auto v2',
        status: 'pending',
        retryCount: 0,
      },
      { workflowId: 'Delivery v2', workflowName: 'Delivery v2', status: 'pending', retryCount: 0 },
    ],
    ...partial,
  }
}

describe('chain.applyExecutionEvent', () => {
  it('done advances to next step', () => {
    const stack = initExecutionStack(['w1', 'w2'])
    stack[0]!.status = 'running'
    const r = applyExecutionEvent(stack, 0, { status: 'done' })
    expect(r.nextStepIndex).toBe(1)
    expect(r.finished).toBe(false)
    expect(r.blocked).toBe(false)
    expect(stack[0]?.status).toBe('done')
    expect(stack[0]?.finishedAt).toBeDefined()
  })

  it('done on last step finishes the chain', () => {
    const stack = initExecutionStack(['w1', 'w2'])
    stack[0]!.status = 'running'
    applyExecutionEvent(stack, 0, { status: 'done' })
    stack[1]!.status = 'running'
    const r = applyExecutionEvent(stack, 1, { status: 'done' })
    expect(r.finished).toBe(true)
    expect(r.blocked).toBe(false)
  })

  it('blocked with retryCount < 2 retries the same step', () => {
    const stack = initExecutionStack(['w1'])
    stack[0]!.status = 'running'
    const r = applyExecutionEvent(stack, 0, { status: 'blocked' })
    expect(r.finished).toBe(false)
    expect(r.blocked).toBe(false)
    expect(stack[0]?.retryCount).toBe(1)
    expect(stack[0]?.status).toBe('running')
  })

  it('blocked with retryCount === 2 finishes blocked', () => {
    const stack = initExecutionStack(['w1'])
    stack[0]!.status = 'running'
    applyExecutionEvent(stack, 0, { status: 'blocked' })
    const r = applyExecutionEvent(stack, 0, { status: 'blocked' })
    expect(r.finished).toBe(true)
    expect(r.blocked).toBe(true)
    expect(stack[0]?.retryCount).toBe(2)
  })
})

describe('chain builders', () => {
  it('buildIssueParams exposes ONLY the parameters the workflows declare', () => {
    // The host maps the positional arguments onto the DECLARED
    // parameters, so a value that no workflow declares is never sent.
    // The real declarations are: plan-issue-v3 → issue_ref + repo ;
    // build-verify-v3 / publish-pr-v1 → workdir.
    //
    // The issue body and the comments are NOT transported: the planner
    // re-reads the issue with an authenticated `gh issue view`, and the
    // host has no channel for free text (the prompt is split on
    // whitespace, so any free text would corrupt the mapping).
    const params = buildIssueParams(entry({}))
    expect(Object.keys(params).sort()).toEqual(['issue_ref', 'repo'])
  })

  it('buildIssueParams supplies issue_ref, a REQUIRED param of the planner', () => {
    // The host throws "Missing required parameter" when a required workflow
    // parameter is absent (openfox src/server/runner/orchestrator.ts), so the
    // whole chain used to be unlaunchable at its first step.
    const params = buildIssueParams(entry({ repoKey: 'theshwal/visipdp', issueNumber: 2024 }))
    expect(params['issue_ref']).toBe('theshwal/visipdp#2024')
    expect('issue_ref' in params).toBe(true)
  })

  it('buildIssueParams supplies the repo the planner reads the issue with', () => {
    // plan-issue-v3 runs `gh issue view "$num" -R "$repo"`: a repo that
    // is not `owner/name` makes the planner fail with "TARGET REJECTED".
    const params = buildIssueParams(entry({ repoKey: 'acme/widgets', issueNumber: 7 }))
    expect(params['repo']).toBe('acme/widgets')
  })

  it('buildIssueContext embeds the URL and body', () => {
    const ctx = buildIssueContext(entry({ body: 'Hello' }))
    expect(ctx).toContain('https://github.com/o/r/issues/1')
    expect(ctx).toContain('Hello')
  })

  it('startChain launches the first workflow and marks it running', () => {
    const e = entry({})
    const driver = { launch: vi.fn() }
    const stack = startChain(e, driver, { sessionId: 'sess1' })
    expect(driver.launch).toHaveBeenCalledOnce()
    expect(stack[0]?.status).toBe('running')
    expect(stack[0]?.startedAt).toBeDefined()
  })

  it('startChain is a no-op when chain is empty', () => {
    const e = entry({ executionStack: [] })
    const driver = { launch: vi.fn() }
    const stack = startChain(e, driver, { sessionId: 'sess1' })
    expect(driver.launch).not.toHaveBeenCalled()
    expect(stack).toHaveLength(0)
  })
})
