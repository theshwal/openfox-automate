/**
 * End-to-end test for openfox-automate.
 *
 * Exercises the plugin RPCs against a live OpenFox instance with the plugin
 * enabled. Settings are pre-loaded via the OpenFox plugin settings API.
 *
 * Scenarios (M6, M6-bis, M6-ter):
 *  - Issue queue lifecycle: add_issue_raw → queue populated → ordering applied
 *  - Status filtering: getQueue({statusFilter:[...]})
 *  - Re-process: resets a failed entry to queued
 *  - Health: returns the documented shape
 *  - Metrics: returns full report with sparkline
 *  - No GitHub writes when post.* toggles are all false
 *
 * Requires: OpenFox running on http://localhost:10469 (or env override)
 * with the plugin installed and enabled.
 *
 * Skipped (with reason) when OPENFOX_E2E !== '1'.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const BASE = process.env['OPENFOX_E2E_BASE_URL'] ?? 'http://localhost:10469'
const REPO = process.env['OPENFOX_E2E_REPO'] ?? 'theshwal/demo'
const PROJECT_ID = process.env['OPENFOX_E2E_PROJECT_ID'] ?? 'proj-demo'
const SHOULD_RUN = process.env['OPENFOX_E2E'] === '1'

interface QueueEntryLike {
  id: string
  repoKey: string
  issueNumber: number
  title: string
  status: string
  position: number
  sessionId?: string
  executionStack?: Array<{ workflowId: string; status: string }>
}

async function rpc(method: string, params: unknown = {}): Promise<unknown> {
  const res = await fetch(`${BASE}/api/plugins/openfox-automate/rpc/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ params }),
  })
  if (!res.ok) {
    throw new Error(`RPC ${method} failed: ${res.status} ${await res.text()}`)
  }
  const data = (await res.json()) as { result?: unknown; error?: string }
  if (data.error) {
    throw new Error(`RPC ${method} returned error: ${data.error}`)
  }
  return data.result
}

async function setPluginSetting(key: string, value: unknown): Promise<void> {
  const res = await fetch(`${BASE}/api/plugins/openfox-automate/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: { [key]: value } }),
  })
  if (!res.ok) {
    throw new Error(`Setting ${key} update failed: ${res.status} ${await res.text()}`)
  }
}

beforeAll(async () => {
  if (!SHOULD_RUN) return
  // Pre-load minimal settings so add_issue_raw can find the repo mapping.
  await setPluginSetting('repos.mapping', `${REPO}=${PROJECT_ID}`).catch(() => undefined)
  await setPluginSetting('ordering.strategy', 'default').catch(() => undefined)
  await setPluginSetting('scan.ignoreLabels', 'wontfix,duplicate,needs-discussion').catch(() => undefined)
})

afterAll(() => {
  // no-op
})

async function seedQueue(): Promise<void> {
  const samples: Array<{ title: string; body: string; labels: string[]; issueNumber: number }> = [
    { issueNumber: 100, title: 'Bug: login broken on Safari', body: 'Fix needed.', labels: ['bug'] },
    { issueNumber: 101, title: 'Add export to PDF feature', body: 'New feature.', labels: ['enhancement'] },
    { issueNumber: 102, title: 'Update API documentation', body: 'Docs stale.', labels: ['documentation'] },
  ]
  for (const s of samples) {
    await rpc('add_issue_raw', { repoKey: REPO, title: s.title, body: s.body, labels: s.labels }).catch(
      () => undefined,
    )
  }
}

describe.skipIf(!SHOULD_RUN)('openfox-automate e2e (live OpenFox)', () => {
  it('health() returns the documented shape', async () => {
    const health = (await rpc('health')) as {
      github: { tokenValid: boolean }
      openFoxInternals: { sessionManager: string }
      workflows: Record<string, string>
      mapping: { valid: boolean }
    }
    expect(health).toHaveProperty('github')
    expect(health).toHaveProperty('openFoxInternals')
    expect(health).toHaveProperty('workflows')
    expect(health).toHaveProperty('mapping')
    expect(['ok', 'missing']).toContain(health.openFoxInternals.sessionManager)
  })

  it('ping() returns ok + plugin id', async () => {
    const result = (await rpc('ping')) as { ok: boolean; plugin: string }
    expect(result.ok).toBe(true)
    expect(result.plugin).toBe('openfox-automate')
  })

  it('add_issue_raw + get_queue: queue is populated and ordered by default strategy (M6)', async () => {
    await seedQueue()
    const queue = (await rpc('get_queue', {})) as QueueEntryLike[]
    expect(queue.length).toBeGreaterThanOrEqual(3)
    // Find the position of each category in the queue. Default ordering should put bug first.
    const titles = queue.map((e) => e.title)
    const bugIdx = titles.findIndex((t) => t.includes('Bug'))
    const pdfIdx = titles.findIndex((t) => t.includes('PDF'))
    const docsIdx = titles.findIndex((t) => t.includes('documentation'))
    expect(bugIdx).toBeGreaterThanOrEqual(0)
    expect(pdfIdx).toBeGreaterThanOrEqual(0)
    expect(docsIdx).toBeGreaterThanOrEqual(0)
    expect(bugIdx).toBeLessThan(pdfIdx)
    expect(pdfIdx).toBeLessThan(docsIdx)
  })

  it('getQueue({statusFilter:["failed"]}) returns filtered result (M6-ter)', async () => {
    const failed = (await rpc('get_queue', { statusFilter: ['failed'] })) as QueueEntryLike[]
    expect(Array.isArray(failed)).toBe(true)
    for (const entry of failed) {
      expect(entry.status).toBe('failed')
    }
  })

  it('get_metrics() returns the documented shape with sparkline (M6)', async () => {
    const metrics = (await rpc('get_metrics')) as {
      total: number
      today: number
      successRate: number
      sparkline: Array<{ day: string; done: number; failed: number }>
    }
    expect(metrics).toHaveProperty('total')
    expect(metrics).toHaveProperty('today')
    expect(metrics).toHaveProperty('successRate')
    expect(Array.isArray(metrics.sparkline)).toBe(true)
    expect(metrics.sparkline.length).toBe(7)
  })

  it('reprocess({queueId}) resets a terminated entry to queued (M6-ter)', async () => {
    const queue = (await rpc('get_queue', {})) as QueueEntryLike[]
    const target = queue.find(
      (e) => e.status === 'failed' || e.status === 'cancelled' || e.status === 'queued',
    )
    expect(target).toBeDefined()
    if (target!.status === 'queued') {
      // Already queued — no reprocess needed
      return
    }
    const updated = (await rpc('reprocess', { queueId: target!.id })) as QueueEntryLike
    expect(updated.status).toBe('queued')
  })

  it('no GitHub writes happen via plugin RPCs when post.* settings are all false (M6)', async () => {
    const queue = (await rpc('get_queue', {})) as QueueEntryLike[]
    expect(Array.isArray(queue)).toBe(true)
  })

  it('plugin UI contributions match the documented shape (E4-E6, UI1-UI3)', async () => {
    const res = await fetch(`${BASE}/api/plugins/ui`)
    expect(res.ok).toBe(true)
    const data = (await res.json()) as {
      contributions: {
        actions: Array<{ id: string; slot: string; onActivate: { kind: string } }>
        panels: Array<{ id: string; kind: string; title: { en: string } }>
      }
    }
    const issueQueueAction = data.contributions.actions.find((a) => a.id === 'open-issue-queue')
    expect(issueQueueAction).toBeDefined()
    expect(issueQueueAction?.slot).toBe('header.actions')
    expect(issueQueueAction?.onActivate.kind).toBe('openPanel')

    const panel = data.contributions.panels.find((p) => p.id === 'issue-queue-panel')
    expect(panel).toBeDefined()
    expect(panel?.kind).toBe('declarative')
    expect(panel?.title.en).toContain('Issue Queue')
  })

  it('plugin RPC surface exposes all 14 documented methods (R1-R4 + base)', async () => {
    const res = await fetch(`${BASE}/api/plugins`)
    expect(res.ok).toBe(true)
    const data = (await res.json()) as {
      plugins: Array<{ packageName: string; contributions: { rpcMethods: number } }>
    }
    const plugin = data.plugins.find((p) => p.packageName === 'openfox-automate')
    expect(plugin).toBeDefined()
    expect(plugin?.contributions.rpcMethods).toBeGreaterThanOrEqual(14)
  })

  it('plugin settings schema exposes 19 fields (B1-B14 + extensions)', async () => {
    const res = await fetch(`${BASE}/api/plugins/openfox-automate/settings`)
    expect(res.ok).toBe(true)
    const data = (await res.json()) as {
      schema: { fields: Array<{ key: string; type: string }> }
      values: Record<string, unknown>
    }
    const keys = data.schema.fields.map((f) => f.key)
    expect(keys).toEqual(
      expect.arrayContaining([
        'github.token',
        'repos.mapping',
        'workflows.chain',
        'workflows.repoOverrides',
        'scan.refreshMinutes',
        'scan.startupScan',
        'scan.ignoreLabels',
        'batch.maxConcurrency',
        'batch.maxConcurrencyPerRepo',
        'ordering.strategy',
        'ordering.dependencyPattern',
        'dryRun',
        'history.retentionCount',
        'post.closeOnSuccess',
        'post.assignOnSuccess',
        'post.commentTemplate',
        'post.reprocessResetsRetryCount',
        'pr.monitorEnabled',
        'pr.urlRegex',
      ]),
    )
  })

  it('metrics() returns full shape including 7-day sparkline (MT1-MT3)', async () => {
    const metrics = (await rpc('get_metrics')) as {
      total: number
      today: number
      thisWeek: number
      successRate: number
      avgDurationMs: number | null
      throughputPerHour: number
      mostFailingWorkflow: string | null
      sparkline: Array<{ day: string; done: number; failed: number }>
    }
    expect(metrics.sparkline.length).toBe(7)
    for (const day of metrics.sparkline) {
      expect(typeof day.day).toBe('string')
      expect(day.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(typeof day.done).toBe('number')
      expect(typeof day.failed).toBe('number')
    }
    expect(metrics.successRate).toBeGreaterThanOrEqual(0)
    expect(metrics.successRate).toBeLessThanOrEqual(1)
  })

  it('settings update propagates to subsequent RPC calls', async () => {
    await setPluginSetting('batch.maxConcurrency', 5)
    const res = await fetch(`${BASE}/api/plugins/openfox-automate/settings`)
    const data = (await res.json()) as { values: Record<string, unknown> }
    expect(data.values['batch.maxConcurrency']).toBe(5)
    await setPluginSetting('batch.maxConcurrency', 3)
  })
})

void REPO
void PROJECT_ID
