/**
 * Queue ordering strategies.
 *
 * Three strategies:
 *  - default: no-blockers → bug > enhancement > docs → FIFO (createdAt asc)
 *  - priority-labels: explicit priority labels → FIFO
 *  - strict-deps: topological sort; cycle or missing dep → marked blocked
 */

import type { QueueEntry, OrderingStrategy } from './types.js'

const BUG_RE = /\b(bug|fix|defect)\b/i
const ENHANCEMENT_RE = /\b(feature|enhancement|improvement)\b/i
const DOCS_RE = /\b(doc|documentation)\b/i

const PRIORITY_LABELS: Array<{ re: RegExp; rank: number }> = [
  { re: /\b(p0|priority[:\s-]?critical|urgent)\b/i, rank: 0 },
  { re: /\b(p1|priority[:\s-]?high)\b/i, rank: 1 },
  { re: /\b(p2|priority[:\s-]?medium)\b/i, rank: 2 },
  { re: /\b(p3|priority[:\s-]?low)\b/i, rank: 3 },
]

function classify(labels: string[]): 'bug' | 'feature' | 'docs' | 'other' {
  if (labels.some((l) => BUG_RE.test(l))) return 'bug'
  if (labels.some((l) => ENHANCEMENT_RE.test(l))) return 'feature'
  if (labels.some((l) => DOCS_RE.test(l))) return 'docs'
  return 'other'
}

function priorityRank(labels: string[]): number {
  for (const { re, rank } of PRIORITY_LABELS) {
    if (labels.some((l) => re.test(l))) return rank
  }
  return 999
}

export function parseDependencies(text: string, pattern: string): number[] {
  let re: RegExp
  try {
    re = new RegExp(pattern, 'gi')
  } catch {
    return []
  }
  const deps = new Set<number>()
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    for (const group of match.slice(1)) {
      const n = Number(group)
      if (Number.isFinite(n) && n > 0) deps.add(n)
    }
  }
  return Array.from(deps)
}

function buildAdjacency(entries: QueueEntry[]): Map<string, string[]> {
  const byNumber = new Map<number, QueueEntry>()
  for (const e of entries) byNumber.set(e.issueNumber, e)
  const adj = new Map<string, string[]>()
  for (const e of entries) {
    adj.set(
      e.id,
      e.dependsOn
        .map((n) => byNumber.get(n))
        .filter((x): x is QueueEntry => Boolean(x))
        .map((x) => x.id),
    )
  }
  return adj
}

function topologicalSort(entries: QueueEntry[]): { sorted: QueueEntry[]; cycle: string[] } {
  const adj = buildAdjacency(entries)
  const inDegree = new Map<string, number>()
  for (const e of entries) inDegree.set(e.id, adj.get(e.id)?.length ?? 0)
  const queue = entries.filter((e) => (inDegree.get(e.id) ?? 0) === 0)
  const sorted: QueueEntry[] = []
  while (queue.length > 0) {
    const next = queue.shift()!
    sorted.push(next)
    for (const other of entries) {
      const deps = adj.get(other.id) ?? []
      if (deps.includes(next.id)) {
        const cur = (inDegree.get(other.id) ?? 0) - 1
        inDegree.set(other.id, cur)
        if (cur === 0) queue.push(other)
      }
    }
  }
  if (sorted.length !== entries.length) {
    const cycle = entries.filter((e) => !sorted.includes(e)).map((e) => e.id)
    return { sorted, cycle }
  }
  return { sorted, cycle: [] }
}

export function orderQueue(
  entries: QueueEntry[],
  strategy: OrderingStrategy,
  depPattern: string,
): { ordered: QueueEntry[]; cycleEntries: QueueEntry[] } {
  const annotated = entries.map((e) => {
    const depsFromText = parseDependencies(
      `${e.title}\n${e.body}\n${e.comments.map((c) => c.body).join('\n')}`,
      depPattern,
    )
    return depsFromText.length > e.dependsOn.length ? { ...e, dependsOn: depsFromText } : e
  })

  if (strategy === 'strict-deps') {
    const { sorted, cycle } = topologicalSort(annotated)
    const cycleSet = new Set(cycle)
    return {
      ordered: sorted.map((e, i) => ({ ...e, position: i + 1 })),
      cycleEntries: annotated.filter((e) => cycleSet.has(e.id)),
    }
  }

  if (strategy === 'priority-labels') {
    const sorted = [...annotated].sort((a, b) => {
      const ra = priorityRank(a.labels)
      const rb = priorityRank(b.labels)
      if (ra !== rb) return ra - rb
      return a.addedAt.localeCompare(b.addedAt)
    })
    return {
      ordered: sorted.map((e, i) => ({ ...e, position: i + 1 })),
      cycleEntries: [],
    }
  }

  // default
  const sorted = [...annotated].sort((a, b) => {
    if (a.dependsOn.length !== b.dependsOn.length) return a.dependsOn.length - b.dependsOn.length
    const ca = classify(a.labels)
    const cb = classify(b.labels)
    const rank = { bug: 0, feature: 1, docs: 2, other: 3 } as const
    if (rank[ca] !== rank[cb]) return rank[ca] - rank[cb]
    return a.addedAt.localeCompare(b.addedAt)
  })
  return {
    ordered: sorted.map((e, i) => ({ ...e, position: i + 1 })),
    cycleEntries: [],
  }
}

export function findMissingDependencies(entries: QueueEntry[]): { entry: QueueEntry; missing: number[] }[] {
  const known = new Set(entries.map((e) => e.issueNumber))
  return entries
    .map((entry) => ({
      entry,
      missing: entry.dependsOn.filter((n) => !known.has(n)),
    }))
    .filter((x) => x.missing.length > 0)
}
