import { describe, expect, it } from 'vitest'
import {
  createOrchestration,
  type LaunchWorkflowParams,
  type OpenFoxOrchestration,
  type SessionLike,
} from '../src/orchestration.js'

interface CallRecord {
  method: 'createSession' | 'stopSession' | 'launchWorkflow'
  args: unknown[]
}

function makeSpy(): { orch: OpenFoxOrchestration; calls: CallRecord[] } {
  const calls: CallRecord[] = []
  return {
    calls,
    orch: {
      async createSession(projectId: string, title: string): Promise<SessionLike> {
        calls.push({ method: 'createSession', args: [projectId, title] })
        return { id: `sess-${calls.length}`, workdir: '/tmp/work' }
      },
      async stopSession(sessionId: string): Promise<void> {
        calls.push({ method: 'stopSession', args: [sessionId] })
      },
      launchWorkflow(params: LaunchWorkflowParams): void {
        calls.push({ method: 'launchWorkflow', args: [params] })
      },
    },
  }
}

describe('orchestration factory (createOrchestration)', () => {
  it('delegates to deps when provided', async () => {
    const { orch, calls } = makeSpy()
    const wrapped = createOrchestration({} as never, orch)

    await wrapped.createSession('p', 't')
    await wrapped.stopSession('s')
    wrapped.launchWorkflow({ sessionId: 's', workflowId: 'w' })

    expect(calls.map((c) => c.method)).toEqual(['createSession', 'stopSession', 'launchWorkflow'])
  })

  it('forwards launch params unchanged (sessionId + workflowId + extras)', async () => {
    const { orch, calls } = makeSpy()
    const wrapped = createOrchestration({} as never, orch)
    wrapped.launchWorkflow({
      sessionId: 's1',
      workflowId: 'Plan Issue v2',
      params: { issue_url: 'https://x' },
      content: 'do the thing',
      subGroup: 'sub',
    })
    const arg = calls[0]?.args[0] as LaunchWorkflowParams
    expect(arg).toEqual({
      sessionId: 's1',
      workflowId: 'Plan Issue v2',
      params: { issue_url: 'https://x' },
      content: 'do the thing',
      subGroup: 'sub',
    })
  })
})
