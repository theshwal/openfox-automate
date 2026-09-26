import { describe, expect, it } from 'vitest'
import { computeMetrics } from '../src/metrics.js'
import type { QueueEntry } from '../src/types.js'

function entry(partial: Partial<QueueEntry>): QueueEntry {
  return {
    id: partial.id ?? 'id',
    repoKey: 'o/r',
    projectId: 'p',
    issueNumber: 1,
    title: 'T',
    body: '',
    url: '',
    labels: [],
    comments: [],
    dependsOn: [],
    status: 'done',
    position: 1,
    addedAt: '2024-01-01T00:00:00.000Z',
    ...partial,
  }
}

describe('computeMetrics', () => {
  it('returns zero counts for empty history', () => {
    const m = computeMetrics([])
    expect(m.total).toBe(0)
    expect(m.today).toBe(0)
    expect(m.successRate).toBe(1)
    expect(m.avgDurationMs).toBeNull()
    expect(m.sparkline).toHaveLength(7)
  })

  it('counts today / week / total correctly', () => {
    const now = new Date()
    const history: QueueEntry[] = [
      entry({ id: '1', status: 'done', finishedAt: now.toISOString(), startedAt: new Date(now.getTime() - 1000).toISOString() }),
      entry({ id: '2', status: 'failed', finishedAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString() }),
      entry({ id: '3', status: 'done', finishedAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString() }),
    ]
    const m = computeMetrics(history)
    expect(m.total).toBe(3)
    expect(m.today).toBe(1)
    expect(m.thisWeek).toBe(2)
    expect(m.successRate).toBeCloseTo(2 / 3)
  })

  it('computes average duration from startedAt/finishedAt', () => {
    const now = Date.now()
    const history: QueueEntry[] = [
      entry({ id: '1', status: 'done', finishedAt: new Date(now).toISOString(), startedAt: new Date(now - 5000).toISOString() }),
      entry({ id: '2', status: 'done', finishedAt: new Date(now).toISOString(), startedAt: new Date(now - 1000).toISOString() }),
    ]
    const m = computeMetrics(history)
    expect(m.avgDurationMs).toBe(3000)
  })

  it('identifies the most-failing workflow', () => {
    const now = Date.now()
    const history: QueueEntry[] = [
      entry({
        id: '1',
        status: 'failed',
        finishedAt: new Date(now).toISOString(),
        executionStack: [
          { workflowId: 'A', workflowName: 'A', status: 'blocked', retryCount: 2 },
          { workflowId: 'B', workflowName: 'B', status: 'pending', retryCount: 0 },
        ],
      }),
      entry({
        id: '2',
        status: 'failed',
        finishedAt: new Date(now).toISOString(),
        executionStack: [
          { workflowId: 'B', workflowName: 'B', status: 'blocked', retryCount: 2 },
        ],
      }),
      entry({
        id: '3',
        status: 'failed',
        finishedAt: new Date(now).toISOString(),
        executionStack: [
          { workflowId: 'B', workflowName: 'B', status: 'blocked', retryCount: 2 },
        ],
      }),
    ]
    const m = computeMetrics(history)
    expect(m.mostFailingWorkflow).toBe('B')
  })

  it('produces a 7-day sparkline', () => {
    const m = computeMetrics([])
    expect(m.sparkline).toHaveLength(7)
    for (const d of m.sparkline) {
      expect(d.done).toBe(0)
      expect(d.failed).toBe(0)
      expect(typeof d.day).toBe('string')
    }
  })
})
