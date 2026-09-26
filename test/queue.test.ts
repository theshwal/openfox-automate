import { describe, expect, it } from 'vitest'
import { QueueStore, canTransition, isTerminated, newEntryId, assertTransition } from '../src/queue.js'
import type { QueueEntry } from '../src/types.js'

function entry(partial: Partial<QueueEntry> & Pick<QueueEntry, 'repoKey' | 'projectId' | 'issueNumber' | 'title'>): QueueEntry {
  return {
    id: newEntryId(),
    body: '',
    url: '',
    labels: [],
    comments: [],
    dependsOn: [],
    status: 'queued',
    position: 0,
    addedAt: new Date().toISOString(),
    ...partial,
  }
}

describe('queue transitions', () => {
  it('validates the documented valid transitions', () => {
    expect(canTransition('queued', 'running')).toBe(true)
    expect(canTransition('queued', 'cancelled')).toBe(true)
    expect(canTransition('running', 'blocked')).toBe(true)
    expect(canTransition('running', 'done')).toBe(true)
    expect(canTransition('running', 'failed')).toBe(true)
    expect(canTransition('blocked', 'running')).toBe(true)
    expect(canTransition('done', 'queued')).toBe(true)
    expect(canTransition('failed', 'queued')).toBe(true)
  })

  it('rejects invalid transitions', () => {
    expect(canTransition('queued', 'done')).toBe(false)
    expect(canTransition('cancelled', 'running')).toBe(false)
    expect(canTransition('done', 'failed')).toBe(false)
    expect(canTransition('running', 'queued')).toBe(false)
  })

  it('throws on assertTransition for invalid', () => {
    expect(() => assertTransition('queued', 'done')).toThrow()
  })

  it('isTerminated identifies terminal statuses', () => {
    expect(isTerminated('done')).toBe(true)
    expect(isTerminated('failed')).toBe(true)
    expect(isTerminated('cancelled')).toBe(true)
    expect(isTerminated('queued')).toBe(false)
    expect(isTerminated('running')).toBe(false)
    expect(isTerminated('blocked')).toBe(false)
  })
})

describe('QueueStore', () => {
  function makeStore(): { store: QueueStore; backing: Map<string, unknown> } {
    const backing = new Map<string, unknown>()
    const store = new QueueStore({
      get: async (k) => backing.get(k),
      set: async (k, v) => {
        backing.set(k, v)
      },
    })
    return { store, backing }
  }

  it('adds new entries without duplicates by (repoKey, issueNumber)', async () => {
    const { store } = makeStore()
    const e1 = entry({ repoKey: 'org/a', projectId: 'p1', issueNumber: 1, title: 'A1' })
    const e2 = entry({ repoKey: 'org/a', projectId: 'p1', issueNumber: 1, title: 'A1-dup' })
    const e3 = entry({ repoKey: 'org/a', projectId: 'p1', issueNumber: 2, title: 'A2' })
    const r1 = await store.addNew([e1])
    expect(r1.added).toHaveLength(1)
    const r2 = await store.addNew([e2, e3])
    expect(r2.added).toHaveLength(1)
    expect(r2.skipped).toBe(1)
    const active = await store.loadActive()
    expect(active).toHaveLength(2)
  })

  it('transitions running → done and moves entry to history', async () => {
    const { store } = makeStore()
    const e = entry({ repoKey: 'org/b', projectId: 'p2', issueNumber: 7, title: 'B7' })
    await store.addNew([e])
    await store.update({ ...e, status: 'running', sessionId: 'sess1' })
    const updated = await store.transitionTo(e.id, 'done', { finishedAt: new Date().toISOString() })
    expect(updated.status).toBe('done')
    const active = await store.loadActive()
    expect(active).toHaveLength(0)
    const history = await store.loadHistory()
    expect(history).toHaveLength(1)
    expect(history[0]?.id).toBe(e.id)
  })

  it('prunes history to retentionCount', async () => {
    const { store } = makeStore()
    for (let i = 0; i < 5; i += 1) {
      const e = entry({ repoKey: 'o/r', projectId: 'p', issueNumber: 100 + i, title: `T${i}` })
      await store.addNew([e])
      await store.update({ ...e, status: 'running' })
      await store.transitionTo(e.id, 'done', { finishedAt: new Date(Date.now() + i).toISOString() })
    }
    await store.pruneHistory(3)
    const history = await store.loadHistory()
    expect(history).toHaveLength(3)
  })

  it('reprocess preserves retryCount when entry is in active queue (not yet terminated)', async () => {
    const { store } = makeStore()
    const e = entry({ repoKey: 'o/r', projectId: 'p', issueNumber: 1, title: 'T' })
    await store.addNew([e])
    await store.update({ ...e, status: 'running', executionStack: [{ workflowId: 'w1', workflowName: 'W1', status: 'blocked', retryCount: 2 }] })
    // entry is blocked (not terminated) — can transition back to queued
    await store.transitionTo(e.id, 'blocked')
    const reprocessed = await store.transitionTo(e.id, 'queued')
    expect(reprocessed.status).toBe('queued')
    expect(reprocessed.executionStack?.[0]?.retryCount).toBe(2)
  })

  it('failed entries are moved to history, not active', async () => {
    const { store } = makeStore()
    const e = entry({ repoKey: 'o/r', projectId: 'p', issueNumber: 1, title: 'T' })
    await store.addNew([e])
    await store.update({ ...e, status: 'running' })
    const failed = await store.transitionTo(e.id, 'failed', { finishedAt: new Date().toISOString() })
    expect(failed.status).toBe('failed')
    const active = await store.loadActive()
    expect(active.find((a) => a.id === e.id)).toBeUndefined()
    const history = await store.loadHistory()
    expect(history.find((h) => h.id === e.id)).toBeDefined()
  })
})
