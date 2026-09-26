/**
 * Queue state store.
 *
 * Persists in context.storage under:
 *   "queue": QueueEntry[]              (active entries)
 *   "history": QueueEntry[]            (terminated entries)
 *
 * The plugin only reads/writes via the storage passed at construction.
 */

import type { QueueEntry, QueueStatus } from './types.js'

const VALID_TRANSITIONS: Record<QueueStatus, QueueStatus[]> = {
  queued: ['running', 'cancelled', 'removed' as QueueStatus],
  running: ['blocked', 'done', 'failed', 'cancelled'],
  blocked: ['running', 'failed', 'cancelled', 'queued'],
  done: ['queued'],
  failed: ['queued'],
  cancelled: ['queued'],
}

export function canTransition(from: QueueStatus, to: QueueStatus): boolean {
  if (from === to) return false
  return (VALID_TRANSITIONS[from] ?? []).includes(to)
}

export function assertTransition(from: QueueStatus, to: QueueStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid queue transition: ${from} → ${to}`)
  }
}

export function dedupKey(repoKey: string, issueNumber: number): string {
  return `${repoKey}#${issueNumber}`
}

export interface QueueStorage {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

const STORAGE_QUEUE = 'queue'
const STORAGE_HISTORY = 'history'

export class QueueStore {
  constructor(private readonly storage: QueueStorage) {}

  async loadActive(): Promise<QueueEntry[]> {
    const raw = (await this.storage.get(STORAGE_QUEUE)) as QueueEntry[] | undefined
    return Array.isArray(raw) ? raw : []
  }

  async loadHistory(): Promise<QueueEntry[]> {
    const raw = (await this.storage.get(STORAGE_HISTORY)) as QueueEntry[] | undefined
    return Array.isArray(raw) ? raw : []
  }

  async saveActive(entries: QueueEntry[]): Promise<void> {
    await this.storage.set(STORAGE_QUEUE, entries)
  }

  async saveHistory(entries: QueueEntry[]): Promise<void> {
    await this.storage.set(STORAGE_HISTORY, entries)
  }

  async addNew(candidates: QueueEntry[]): Promise<{ added: QueueEntry[]; skipped: number }> {
    const active = await this.loadActive()
    const existing = new Set(active.map((e) => dedupKey(e.repoKey, e.issueNumber)))
    const fresh = candidates.filter((c) => !existing.has(dedupKey(c.repoKey, c.issueNumber)))
    if (fresh.length > 0) {
      const next = [...active, ...fresh]
      await this.saveActive(next)
    }
    return { added: fresh, skipped: candidates.length - fresh.length }
  }

  async replace(entries: QueueEntry[]): Promise<void> {
    await this.saveActive(entries)
  }

  async findById(id: string): Promise<QueueEntry | undefined> {
    const active = await this.loadActive()
    return active.find((e) => e.id === id)
  }

  async update(entry: QueueEntry): Promise<QueueEntry> {
    const active = await this.loadActive()
    const idx = active.findIndex((e) => e.id === entry.id)
    if (idx < 0) throw new Error(`Queue entry not found: ${entry.id}`)
    active[idx] = entry
    await this.saveActive(active)
    return entry
  }

  async transitionTo(
    id: string,
    next: QueueStatus,
    patch: Partial<QueueEntry> = {},
  ): Promise<QueueEntry> {
    const active = await this.loadActive()
    const idx = active.findIndex((e) => e.id === id)
    if (idx < 0) throw new Error(`Queue entry not found: ${id}`)
    const current = active[idx]!
    assertTransition(current.status, next)
    const updated: QueueEntry = { ...current, ...patch, status: next }
    active[idx] = updated
    if (isTerminated(next)) {
      const terminated = { ...updated, finishedAt: updated.finishedAt ?? new Date().toISOString() }
      active.splice(idx, 1)
      const history = await this.loadHistory()
      history.unshift(terminated)
      await this.saveActive(active)
      await this.saveHistory(history)
      return terminated
    }
    await this.saveActive(active)
    return updated
  }

  async remove(id: string): Promise<void> {
    const active = await this.loadActive()
    const next = active.filter((e) => e.id !== id)
    await this.saveActive(next)
  }

  async pruneHistory(retention: number): Promise<void> {
    const history = await this.loadHistory()
    if (history.length <= retention) return
    const sorted = [...history].sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))
    const kept = sorted.slice(0, retention)
    await this.saveHistory(kept)
  }
}

export function isTerminated(status: QueueStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled'
}

export function newEntryId(): string {
  return `qe_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}
