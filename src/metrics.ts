/**
 * Metrics computation — lazy, no background timer.
 *
 * Pulls history from the QueueStore and computes:
 *  - issues today / this week / total
 *  - average chain duration
 *  - success rate
 *  - current throughput (issues/hour over the last 24h)
 *  - most-failing workflow
 *  - 7-day sparkline (done vs failed per day)
 */

import type { QueueEntry } from './types.js'

export interface MetricsReport {
  total: number
  today: number
  thisWeek: number
  successRate: number
  avgDurationMs: number | null
  throughputPerHour: number
  mostFailingWorkflow: string | null
  sparkline: Array<{ day: string; done: number; failed: number }>
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function computeMetrics(history: QueueEntry[]): MetricsReport {
  const terminated = history.filter(
    (h) => h.status === 'done' || h.status === 'failed' || h.status === 'cancelled',
  )
  const now = new Date()
  const today = startOfDay(now)
  const weekAgo = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000)
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000)

  let countToday = 0
  let countWeek = 0
  let countLast24h = 0
  const durations: number[] = []
  let done = 0
  let failed = 0
  const workflowFailures = new Map<string, number>()
  const sparkline = new Map<string, { day: string; done: number; failed: number }>()

  for (let i = 0; i < 7; i += 1) {
    const d = new Date(weekAgo.getTime() + i * 24 * 60 * 60 * 1000)
    const key = dayKey(d)
    sparkline.set(key, { day: key, done: 0, failed: 0 })
  }

  for (const entry of terminated) {
    if (!entry.finishedAt) continue
    const finishedAt = new Date(entry.finishedAt)
    if (finishedAt >= today) countToday += 1
    if (finishedAt >= weekAgo) countWeek += 1
    if (finishedAt >= last24h) countLast24h += 1
    if (entry.status === 'done') {
      done += 1
      const key = dayKey(finishedAt)
      const bucket = sparkline.get(key)
      if (bucket) bucket.done += 1
      if (entry.startedAt) {
        durations.push(new Date(entry.finishedAt).getTime() - new Date(entry.startedAt).getTime())
      }
    } else if (entry.status === 'failed') {
      failed += 1
      const key = dayKey(finishedAt)
      const bucket = sparkline.get(key)
      if (bucket) bucket.failed += 1
      const failedStep = entry.executionStack?.findLast?.((s) => s.status === 'blocked')
      const wfId = failedStep?.workflowId
      if (wfId) workflowFailures.set(wfId, (workflowFailures.get(wfId) ?? 0) + 1)
    }
  }

  const successRate = done + failed > 0 ? done / (done + failed) : 1
  const avgDurationMs =
    durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null
  const throughputPerHour = Math.round((countLast24h / 24) * 100) / 100

  let mostFailingWorkflow: string | null = null
  let max = 0
  for (const [id, n] of workflowFailures) {
    if (n > max) {
      max = n
      mostFailingWorkflow = id
    }
  }

  return {
    total: terminated.length,
    today: countToday,
    thisWeek: countWeek,
    successRate,
    avgDurationMs,
    throughputPerHour,
    mostFailingWorkflow,
    sparkline: Array.from(sparkline.values()),
  }
}
