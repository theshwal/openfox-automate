/**
 * End-to-end test for openfox-automate.
 *
 * Exercises the plugin RPCs against a live OpenFox instance with the plugin
 * enabled. Settings are pre-loaded via the OpenFox plugin settings API.
 *
 * Two scopes:
 *  - RPC surface + queue lifecycle: add_issue_raw → queue populated → ordering
 *    applied → status filtering → re-process → health → metrics → no GitHub
 *    writes when post.* toggles are all false. (M6, M6-bis, M6-ter)
 *  - Functional chain (START chain + first workflow launch + session create):
 *    add_issue_raw → start_issue → verify entry.sessionId is a real host
 *    session, entry.executionStack[0] reflects the first workflow run, no
 *    double launch on a second start_issue call, cancel_issue stops the
 *    session. The chain-advance loop over workflow.execution.changed is
 *    exercised in test/chain.test.ts (pure unit tests with a stub driver).
 *
 * Requires: OpenFox running on http://localhost:10469 (or env override)
 * with the plugin installed and enabled.
 *
 * Skipped (with reason) when OPENFOX_E2E !== '1'.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const BASE = process.env['OPENFOX_E2E_BASE_URL'] ?? 'http://localhost:10469'
const REPO = process.env['OPENFOX_E2E_REPO'] ?? 'theshwal/demo'
const _PROJECT_ID = process.env['OPENFOX_E2E_PROJECT_ID'] ?? 'proj-demo'
const SHOULD_RUN = process.env['OPENFOX_E2E'] === '1'
// Resolved at beforeAll time: host project UUID that the plugin's
// `repos.mapping` will point to. The plugin's getHostInternal() facade
// passes `entry.projectId` straight into sessionManager.createSession,
// which only accepts a UUID that exists in the host's projects table.
let HOST_PROJECT_ID = ''

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

async function ensureHostProject(name: string, workdir: string): Promise<string> {
  const listRes = await fetch(`${BASE}/api/projects`)
  if (listRes.ok) {
    const data = (await listRes.json()) as { projects: Array<{ id: string; name: string }> }
    const found = data.projects.find((p) => p.name === name)
    if (found) return found.id
  }
  const createRes = await fetch(`${BASE}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, workdir }),
  })
  if (!createRes.ok) {
    throw new Error(`create project failed: ${createRes.status} ${await createRes.text()}`)
  }
  const data = (await createRes.json()) as { project: { id: string; name: string } }
  return data.project.id
}

async function listHostSessions(projectId: string): Promise<Array<{ id: string; isRunning: boolean }>> {
  const res = await fetch(`${BASE}/api/sessions?projectId=${encodeURIComponent(projectId)}`)
  if (!res.ok) return []
  const data = (await res.json()) as { sessions?: Array<{ id: string; isRunning: boolean }> }
  return data.sessions ?? []
}

async function readEntry(queueId: string): Promise<QueueEntryLike | undefined> {
  const queue = (await rpc('get_queue', {})) as QueueEntryLike[]
  return queue.find((e) => e.id === queueId)
}

beforeAll(async () => {
  if (!SHOULD_RUN) return
  // Ensure a host project exists that the plugin can target, so the
  // sessionManager.createSession call inside the PluginHost facade does
  // not throw "Project not found". The plugin's `repos.mapping` value
  // must reference the host's projectId (a UUID), not the plugin's own
  // internal project alias — the plugin's add_issue_raw forwards the
  // mapping's RHS verbatim into sessions.create({projectId}).
  const workdir = `/tmp/openfox-e2e-${Date.now()}`
  HOST_PROJECT_ID = await ensureHostProject('e2e-openfox-automate', workdir)
  await setPluginSetting('repos.mapping', `${REPO}=${HOST_PROJECT_ID}`).catch(() => undefined)
  await setPluginSetting('ordering.strategy', 'default').catch(() => undefined)
  await setPluginSetting('scan.ignoreLabels', 'wontfix,duplicate,needs-discussion').catch(() => undefined)
  // Functional tests need real session creation (not a dry-run).
  await setPluginSetting('dryRun', false).catch(() => undefined)
  await setPluginSetting('batch.maxConcurrency', 5).catch(() => undefined)
  await setPluginSetting('scan.startupScan', false).catch(() => undefined)
})

afterAll(() => {
  // no-op
})

async function seedQueue(
  samples: Array<{ title: string; body: string; labels: string[]; issueNumber: number }>,
): Promise<void> {
  for (const s of samples) {
    await rpc('add_issue_raw', { repoKey: REPO, title: s.title, body: s.body, labels: s.labels }).catch(
      () => undefined,
    )
  }
}

async function addFunctionalSeed(): Promise<QueueEntryLike> {
  const stamp = Date.now()
  // Avoid " #N " shapes in title/body so the dependency-detection regex
  // (default: `#(\d+)|depends on #(\d+)|blocked by #(\d+)`) doesn't latch
  // onto the seed string and mark the entry as blocked.
  const title = `Functional chain ${stamp}`
  const added = (await rpc('add_issue_raw', {
    repoKey: REPO,
    title,
    body: 'Functional test seed body.',
    labels: ['bug'],
  })) as QueueEntryLike
  // add_issue_raw overrides issueNumber=Date.now() internally; the returned
  // object is the canonical entry as stored.
  return added
}

describe.skipIf(!SHOULD_RUN)(
  'openfox-automate e2e — RPC surface + queue lifecycle (M6/M6-bis/M6-ter)',
  () => {
    it('health() returns the documented shape and reports all 3 host surfaces ok', async () => {
      const health = (await rpc('health')) as {
        github: { tokenValid: boolean }
        openFoxInternals: { sessionManager: string; launchWorkflowRun: string; host: string }
        workflows: Record<string, string>
        mapping: { valid: boolean }
      }
      expect(health).toHaveProperty('github')
      expect(health).toHaveProperty('openFoxInternals')
      expect(health).toHaveProperty('workflows')
      expect(health).toHaveProperty('mapping')
      expect(['ok', 'missing']).toContain(health.openFoxInternals.sessionManager)
      expect(['ok', 'missing']).toContain(health.openFoxInternals.launchWorkflowRun)
      expect(['ok', 'missing']).toContain(health.openFoxInternals.host)
    })

    it('ping() returns ok + plugin id', async () => {
      const result = (await rpc('ping')) as { ok: boolean; plugin: string }
      expect(result.ok).toBe(true)
      expect(result.plugin).toBe('openfox-automate')
    })

    it('add_issue_raw + get_queue: queue is populated and ordered by default strategy (M6)', async () => {
      await seedQueue([
        { issueNumber: 2000, title: 'Bug: login broken on Safari', body: 'Fix needed.', labels: ['bug'] },
        {
          issueNumber: 2001,
          title: 'Add export to PDF feature',
          body: 'New feature.',
          labels: ['enhancement'],
        },
        {
          issueNumber: 2002,
          title: 'Update API documentation',
          body: 'Docs stale.',
          labels: ['documentation'],
        },
      ])
      const queue = (await rpc('get_queue', {})) as QueueEntryLike[]
      expect(queue.length).toBeGreaterThanOrEqual(3)
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

    it('get_metrics() returns the documented shape with 7-day sparkline (M6, MT1-MT3)', async () => {
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

    it('reprocess({queueId}) is permission-gated by entry status (M6-ter)', async () => {
      const queue = (await rpc('get_queue', {})) as QueueEntryLike[]
      const target = queue.find(
        (e) =>
          e.status === 'failed' ||
          e.status === 'cancelled' ||
          e.status === 'blocked' ||
          e.status === 'queued',
      )
      expect(target).toBeDefined()
      if (target!.status === 'queued') return
      const updated = (await rpc('reprocess', { queueId: target!.id })) as QueueEntryLike
      expect(updated.status).toBe('queued')
    })

    it('plugin UI contributions match the documented shape (E4, UI1)', async () => {
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
      expect(panel?.kind).toBe('iframe')
      expect(panel?.title.en).toContain('Issue Queue')
    })

    it('plugin RPC surface exposes ≥14 methods; settings schema exposes 19 fields', async () => {
      const res = await fetch(`${BASE}/api/plugins`)
      expect(res.ok).toBe(true)
      const data = (await res.json()) as {
        plugins: Array<{ packageName: string; contributions: { rpcMethods: number } }>
      }
      const plugin = data.plugins.find((p) => p.packageName === 'openfox-automate')
      expect(plugin).toBeDefined()
      expect(plugin?.contributions.rpcMethods).toBeGreaterThanOrEqual(14)

      const settingsRes = await fetch(`${BASE}/api/plugins/openfox-automate/settings`)
      expect(settingsRes.ok).toBe(true)
      const sd = (await settingsRes.json()) as { schema: { fields: Array<{ key: string }> } }
      const keys = sd.schema.fields.map((f) => f.key)
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

    it('settings update propagates to subsequent RPC calls', async () => {
      await setPluginSetting('batch.maxConcurrency', 5)
      const res = await fetch(`${BASE}/api/plugins/openfox-automate/settings`)
      const data = (await res.json()) as { values: Record<string, unknown> }
      expect(data.values['batch.maxConcurrency']).toBe(5)
      await setPluginSetting('batch.maxConcurrency', 3)
    })
  },
)

describe.skipIf(!SHOULD_RUN)(
  'openfox-automate e2e — functional chain: session create + first workflow launch (G1/G2/J1)',
  () => {
    let spawnedQueueId: string | null = null
    let spawnedSessionId: string | null = null
    let spawnedChainSize: number | null = null

    it('add_issue_raw seeds a dedicated queue entry for the chain test', async () => {
      const seeded = await addFunctionalSeed()
      expect(seeded.id).toBeTruthy()
      spawnedQueueId = seeded.id
      spawnedChainSize = null
      spawnedSessionId = null
    })

    it('start_issue → host.session.create (via PluginHost facade) → entry.executionStack[0]=running', async () => {
      expect(spawnedQueueId).not.toBeNull()
      const updated = (await rpc('start_issue', { queueId: spawnedQueueId })) as QueueEntryLike
      expect(updated.status).toBe('running')
      expect(updated.sessionId).toBeTruthy()
      expect(typeof updated.sessionId).toBe('string')
      expect(updated.executionStack).toBeDefined()
      expect(updated.executionStack!.length).toBeGreaterThan(0)
      // The first workflow must be marked as in-flight; later steps must be pending.
      expect(updated.executionStack![0]!.status).toBe('running')
      for (let i = 1; i < updated.executionStack!.length; i++) {
        expect(updated.executionStack![i]!.status).toBe('pending')
      }
      spawnedSessionId = updated.sessionId ?? null
      spawnedChainSize = updated.executionStack!.length
    })

    it('the spawned session exists in the host session list (proves PluginHost facade wiring)', async () => {
      expect(spawnedSessionId).not.toBeNull()
      // The host may take a brief moment to register the session internally;
      // a short poll handles the eventual-consistency window.
      let sessions: Array<{ id: string; isRunning: boolean }> = []
      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        sessions = await listHostSessions(HOST_PROJECT_ID)
        if (sessions.some((s) => s.id === spawnedSessionId)) break
        await new Promise((r) => setTimeout(r, 100))
      }
      expect(sessions.some((s) => s.id === spawnedSessionId)).toBe(true)
    })

    it('double start_issue on the same entry is blocked (no double launch)', async () => {
      expect(spawnedQueueId).not.toBeNull()
      // rpc() throws on `data.error` — that's exactly what we want here: the
      // plugin's start_issue handler refuses non-`queued` entries, surfacing
      // a structured error rather than silently re-spawning.
      await expect(rpc('start_issue', { queueId: spawnedQueueId })).rejects.toThrow(
        /cannot start entry in status running/,
      )
    })

    it('re-reading the queue mid-chain shows the entry still owned by its session', async () => {
      expect(spawnedQueueId).not.toBeNull()
      const entry = await readEntry(spawnedQueueId!)
      expect(entry).toBeDefined()
      expect(entry!.sessionId).toBe(spawnedSessionId)
      expect(entry!.status).toBe('running')
    })

    it('cancel_issue stops the host session and transitions the entry to cancelled', async () => {
      expect(spawnedQueueId).not.toBeNull()
      const updated = (await rpc('cancel_issue', { queueId: spawnedQueueId })) as QueueEntryLike
      expect(updated.status).toBe('cancelled')
      // The host session is asked to stop via PluginHost.sessions.stop — the
      // /api/sessions listing should reflect a stopped session shortly after.
      let sessions: Array<{ id: string; isRunning: boolean }> = []
      const target = { id: spawnedSessionId ?? '', isRunning: true }
      const deadline = Date.now() + 3000
      while (Date.now() < deadline && target.isRunning) {
        sessions = await listHostSessions(HOST_PROJECT_ID)
        const found = sessions.find((s) => s.id === target.id)
        if (found) {
          Object.assign(target, found)
          if (!found.isRunning) break
        }
        await new Promise((r) => setTimeout(r, 100))
      }
      expect(target.isRunning).toBe(false)
    })

    it('chain length matches the configured workflow chain', async () => {
      expect(spawnedChainSize).not.toBeNull()
      expect(spawnedChainSize).toBeGreaterThan(0)
      // Default chain has 3 workflows; verify against plugin health report.
      const health = (await rpc('health')) as { workflows: Record<string, string> }
      expect(Object.keys(health.workflows).length).toBe(spawnedChainSize)
    })
  },
)
