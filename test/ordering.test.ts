import { describe, expect, it } from 'vitest'
import { orderQueue, parseDependencies, findMissingDependencies } from '../src/ordering.js'
import { newEntryId } from '../src/queue.js'
import type { QueueEntry } from '../src/types.js'

function entry(partial: Partial<QueueEntry> & Pick<QueueEntry, 'issueNumber' | 'title'>): QueueEntry {
  return {
    id: `id_${partial.issueNumber}`,
    repoKey: 'o/r',
    projectId: 'p',
    body: '',
    url: '',
    labels: [],
    comments: [],
    dependsOn: [],
    status: 'queued',
    position: 0,
    addedAt: new Date(Date.now() + (partial.issueNumber ?? 0)).toISOString(),
    ...partial,
  }
}

describe('parseDependencies', () => {
  it('extracts numeric deps from matches', () => {
    expect(parseDependencies('depends on #12. Also depends on #34.', '(depends on #(\\d+))')).toEqual([12, 34])
  })

  it('returns empty array for invalid regex', () => {
    expect(parseDependencies('foo', '(unbalanced')).toEqual([])
  })

  it('deduplicates', () => {
    expect(parseDependencies('#5 #5 #6', '(#(\\d+))')).toEqual([5, 6])
  })
})

describe('orderQueue — default strategy', () => {
  it('orders bug before feature before docs before other', () => {
    const entries = [
      entry({ issueNumber: 1, title: 'A', labels: ['enhancement'] }),
      entry({ issueNumber: 2, title: 'B', labels: ['bug'] }),
      entry({ issueNumber: 3, title: 'C', labels: ['documentation'] }),
      entry({ issueNumber: 4, title: 'D', labels: [] }),
    ]
    const { ordered } = orderQueue(entries, 'default', '(#(\\d+))')
    expect(ordered.map((e) => e.issueNumber)).toEqual([2, 1, 3, 4])
    expect(ordered[0]?.position).toBe(1)
  })

  it('FIFO tie-break within same category', () => {
    const entries = [
      entry({ issueNumber: 1, title: 'A', labels: ['bug'] }),
      entry({ issueNumber: 2, title: 'B', labels: ['bug'] }),
      entry({ issueNumber: 3, title: 'C', labels: ['bug'] }),
    ]
    const { ordered } = orderQueue(entries, 'default', '(#(\\d+))')
    expect(ordered.map((e) => e.issueNumber)).toEqual([1, 2, 3])
  })

  it('no-blockers come before entries with deps', () => {
    const entries = [
      entry({ issueNumber: 1, title: 'A', labels: ['bug'], dependsOn: [2] }),
      entry({ issueNumber: 2, title: 'B', labels: ['bug'], dependsOn: [] }),
    ]
    const { ordered } = orderQueue(entries, 'default', '(#(\\d+))')
    expect(ordered.map((e) => e.issueNumber)).toEqual([2, 1])
  })
})

describe('orderQueue — priority-labels strategy', () => {
  it('orders by priority label rank', () => {
    const entries = [
      entry({ issueNumber: 1, title: 'A', labels: ['p3'] }),
      entry({ issueNumber: 2, title: 'B', labels: ['p0'] }),
      entry({ issueNumber: 3, title: 'C', labels: ['p1'] }),
      entry({ issueNumber: 4, title: 'D', labels: [] }),
    ]
    const { ordered } = orderQueue(entries, 'priority-labels', '(#(\\d+))')
    expect(ordered.map((e) => e.issueNumber)).toEqual([2, 3, 1, 4])
  })
})

describe('orderQueue — strict-deps strategy', () => {
  it('returns topological order', () => {
    const entries = [
      entry({ issueNumber: 1, title: 'A', dependsOn: [2] }),
      entry({ issueNumber: 2, title: 'B', dependsOn: [3] }),
      entry({ issueNumber: 3, title: 'C', dependsOn: [] }),
    ]
    const { ordered, cycleEntries } = orderQueue(entries, 'strict-deps', '(#(\\d+))')
    expect(ordered.map((e) => e.issueNumber)).toEqual([3, 2, 1])
    expect(cycleEntries).toHaveLength(0)
  })

  it('detects cycles', () => {
    const entries = [
      entry({ issueNumber: 1, title: 'A', dependsOn: [2] }),
      entry({ issueNumber: 2, title: 'B', dependsOn: [1] }),
    ]
    const { cycleEntries } = orderQueue(entries, 'strict-deps', '(#(\\d+))')
    expect(cycleEntries).toHaveLength(2)
  })

  it('includes a and b regardless of order', () => {
    const a = entry({ issueNumber: 10, title: 'A' })
    const b = entry({ issueNumber: 11, title: 'B' })
    const r1 = orderQueue([a, b], 'default', '(#(\\d+))')
    const r2 = orderQueue([b, a], 'default', '(#(\\d+))')
    expect(r1.ordered.map((e) => e.id).sort()).toEqual(r2.ordered.map((e) => e.id).sort())
  })
})

describe('findMissingDependencies', () => {
  it('reports entries referencing unknown issue numbers', () => {
    const a = entry({ issueNumber: 1, dependsOn: [99] })
    const b = entry({ issueNumber: 2, dependsOn: [] })
    const result = findMissingDependencies([a, b])
    expect(result).toHaveLength(1)
    expect(result[0]?.missing).toEqual([99])
  })

  it('returns empty when all deps are satisfied', () => {
    const a = entry({ issueNumber: 1, dependsOn: [2] })
    const b = entry({ issueNumber: 2, dependsOn: [] })
    expect(findMissingDependencies([a, b])).toHaveLength(0)
  })
})

void newEntryId
