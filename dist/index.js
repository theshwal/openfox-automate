/**
 * openfox-automate — plugin entry point.
 *
 * Wires together: settings, UI panel + header action, RPC handlers, hooks,
 * LLM tools, scan timer. Runtime state lives in `context.storage` under
 * "queue", "history", "scan_state", "executions".
 */
import { settingsSchema, parseRepoMapping, parseChain, parseRepoOverrides, parseIgnoreLabels, clampSettings, } from './settings.js';
import { QueueStore, isTerminated, newEntryId } from './queue.js';
import { orderQueue, findMissingDependencies } from './ordering.js';
import { fetchAllOpenIssues, getIssue, listIssueComments, validateToken, isPullRequest } from './github.js';
import { spawnSessionFor } from './spawner.js';
import { startChain, buildIssueContext, buildIssueParams, processWorkflowEvent } from './chain.js';
import { createOrchestration } from './orchestration.js';
import { getHostInternal } from './resolve-openfox.js';
import { extractToolOutputText, normalizeWorkflowExecutionPayload, readSessionId } from './host-events.js';
import { ControlPlaneStore, controlPlaneOptionsFromSettings } from './control-plane-store.js';
import { findDivergence, syncQueueStatus } from './state-ownership.js';
import { admit, completeItem, computeControlPlaneMetrics, dependencyState, markRunning, recordTokenUsage, reserve, } from './control-plane.js';
import { postProcess, fetchAuthenticatedLogin } from './postprocess.js';
import { computeMetrics } from './metrics.js';
import { DEFAULT_SETTINGS } from './types.js';
import { RPC_NAMESPACE } from './constants.js';
let currentRt = null;
/**
 * Test-only lifecycle helpers. They are exported because the test suite
 * needs a deterministic reset between scenarios, but they MUST not be
 * available in the production plugin surface — gating them on
 * `process.env.NODE_ENV !== 'production'` removes them from the runtime
 * API exposed to a host that installs the package and from the bundled
 * `dist/index.d.ts` consumers rely on for typing.
 */
function isTestEnv() {
    return process.env['NODE_ENV'] !== 'production';
}
export function _resetLifecycleForTesting() {
    if (!isTestEnv())
        return;
    if (currentRt) {
        if (currentRt.timer)
            clearInterval(currentRt.timer);
        currentRt.timer = null;
        currentRt.abortController.abort();
    }
    currentRt = null;
}
export function _hasActiveRuntimeForTesting() {
    return isTestEnv() && currentRt !== null;
}
function readSettingsFromContext(context) {
    const raw = (context.settings ? context.settings() : {});
    const merged = { ...DEFAULT_SETTINGS, ...raw };
    // The clamps are applied on the REAL path: the host validates the
    // settings form, but a value set through another route (or a future
    // host version) must not be able to push the worker count past its
    // ceiling.
    return clampSettings(merged);
}
function hasAnyPostToggle(settings) {
    return Boolean(settings['post.commentTemplate'] || settings['post.closeOnSuccess'] || settings['post.assignOnSuccess']);
}
/**
 * Default chain, in STABLE WORKFLOW IDs.
 *
 * The host resolves a launch by `metadata.id` (`findWorkflowById` in
 * src/server/runner/orchestrator.ts), never by display name — a name like
 * "Plan Issue v2" cannot be resolved and the launch throws. The previous
 * default used display names, so the fallback chain was unlaunchable.
 *
 * V3: plan -> build+verify -> publish. There is deliberately no merge
 * workflow in the chain: `publish-pr-v1` stops at the PR, and the merge
 * policy (owner, mode, method) is read by OpenFox after publication.
 */
const DEFAULT_CHAIN = ['plan-issue-v3', 'build-verify-v3', 'publish-pr-v1'];
function defaultChain() {
    return [...DEFAULT_CHAIN];
}
function resolveChain(entry, settings) {
    const overrides = parseRepoOverrides(settings['workflows.repoOverrides']);
    const fromOverride = overrides.get(entry.repoKey);
    if (fromOverride && fromOverride.length > 0)
        return fromOverride;
    return parseChain(settings['workflows.chain']).length > 0
        ? parseChain(settings['workflows.chain'])
        : defaultChain();
}
async function scanAll(rt) {
    // If the plugin was deactivated mid-scan, the AbortController fires and
    // every in-flight fetch in github.ts will return error='aborted'. From
    // that point on we MUST NOT mutate host state (no notify, no storage,
    // no publish) — doing so would let a disabled plugin keep writing
    // through the host. We also guard the post-fetch state mutations with
    // a runtime-identity check so a stale async task that resumes after a
    // re-register() can also be told to exit cleanly.
    const settings = readSettingsFromContext(rt.context);
    const signal = rt.abortController.signal;
    const isLive = () => !signal.aborted && currentRt === rt;
    const token = settings['github.token'];
    if (!token) {
        return { added: 0, skipped: 0, errors: ['missing github.token'] };
    }
    // L1 rate-limit backoff: if a previous scan hit the limit, wait until reset.
    if (rt.rateLimitedUntil && Date.now() < rt.rateLimitedUntil) {
        return {
            added: 0,
            skipped: 0,
            errors: [`rate-limited until ${new Date(rt.rateLimitedUntil).toISOString()}`],
        };
    }
    rt.rateLimitedUntil = null;
    const repos = parseRepoMapping(settings['repos.mapping']);
    if (repos.length === 0) {
        return { added: 0, skipped: 0, errors: ['no repos mapped'] };
    }
    const ignoreLabels = parseIgnoreLabels(settings['scan.ignoreLabels']);
    const dryRun = Boolean(settings.dryRun);
    const errors = [];
    const candidates = [];
    for (const { repoKey, projectId } of repos) {
        if (!isLive()) {
            errors.push(`aborted: scanAll stopped after deactivate (${repoKey} skipped)`);
            break;
        }
        const [owner, repo] = repoKey.split('/', 2);
        if (!owner || !repo) {
            errors.push(`invalid repoKey ${repoKey}`);
            continue;
        }
        const res = await fetchAllOpenIssues(token, owner, repo, { signal });
        if (!isLive()) {
            errors.push(`aborted: scanAll stopped after deactivate (${repoKey} skipped)`);
            break;
        }
        if (res.error === 'aborted') {
            errors.push(`aborted: ${repoKey} fetch aborted`);
            break;
        }
        if (!res.ok || !res.data) {
            errors.push(`${repoKey}: ${res.error ?? res.status}`);
            rt.context.notify({
                title: { en: 'Repo scan failed', fr: 'Échec du scan' },
                body: { en: `Could not scan ${repoKey}`, fr: `Impossible de scanner ${repoKey}` },
                level: 'error',
            });
            continue;
        }
        if (res.rateLimit.remaining < 100) {
            rt.context.notify({
                title: { en: 'GitHub rate limit low', fr: 'Rate-limit GitHub bas' },
                body: { en: `${res.rateLimit.remaining} remaining`, fr: `${res.rateLimit.remaining} restant(s)` },
                level: 'warning',
            });
        }
        for (const issue of res.data) {
            if (isPullRequest(issue))
                continue;
            const labels = issue.labels.map((l) => (typeof l === 'string' ? l : l.name));
            if (ignoreLabels.length > 0 && labels.some((l) => ignoreLabels.includes(l.toLowerCase())))
                continue;
            candidates.push({
                id: newEntryId(),
                repoKey,
                projectId,
                issueNumber: issue.number,
                title: issue.title,
                body: issue.body ?? '',
                url: issue.html_url,
                labels,
                comments: [],
                dependsOn: [],
                status: 'queued',
                position: 0,
                addedAt: new Date().toISOString(),
            });
        }
    }
    // Final deactivate-guard: aborts can land between the per-repo loop
    // and the post-fetch bookkeeping below. Don't write anything back to
    // the host if we've been torn down.
    if (!isLive()) {
        errors.push('aborted: scanAll stopped before storing results');
        return { added: 0, skipped: 0, errors };
    }
    const { added, skipped } = await rt.store.addNew(candidates);
    const ordered = await orderAndStore(rt);
    // Admit the same candidates into the durable control-plane registry, so
    // the scheduler owns an exclusive, crash-safe view of what may run.
    await rt.controlPlane.mutate((state) => {
        // The dependencies come from the ORDERED entries: `orderQueue` derives
        // them from the issue text (the `#N` references), and the raw scan
        // candidates carry an empty list. Admitting them with an empty list
        // made the control plane disagree with the legacy view, which blocks
        // the entries whose dependency is missing.
        const orderedByKey = new Map(ordered.map((e) => [`${e.repoKey}#${e.issueNumber}`, e]));
        // The DERIVED status is mirrored too: `orderAndStore` blocked the
        // entries whose dependency is missing, and admitting them as 'queued'
        // made the two views disagree (and the scheduler started an issue
        // whose prerequisite was absent).
        const blockedIds = new Set(ordered.filter((e) => e.status === 'blocked').map((e) => `${e.repoKey}#${e.issueNumber}`));
        admit(state, candidates.map((c) => {
            const key = `${c.repoKey}#${c.issueNumber}`;
            const derived = orderedByKey.get(key);
            return {
                repoKey: c.repoKey,
                projectId: c.projectId,
                issueNumber: c.issueNumber,
                title: c.title,
                url: c.url,
                labels: c.labels,
                dependsOn: derived?.dependsOn ?? c.dependsOn,
                blocked: blockedIds.has(key),
                blockedReason: derived?.error,
            };
        }));
    });
    rt.lastScanAt = new Date().toISOString();
    publishQueue(rt, ordered);
    if (added.length > 0 && !dryRun) {
        rt.context.notify({
            title: {
                en: `${added.length} new issue(s) in queue`,
                fr: `${added.length} nouvelle(s) issue(s) dans la file`,
            },
            level: 'info',
        });
    }
    return { added: added.length, skipped, errors };
}
async function orderAndStore(rt) {
    const settings = readSettingsFromContext(rt.context);
    const active = await rt.store.loadActive();
    const { ordered, cycleEntries } = orderQueue(active, settings['ordering.strategy'] ?? 'default', settings['ordering.dependencyPattern'] ?? '(#(\\d+))');
    const blockedByMissing = findMissingDependencies(ordered).map((x) => x.entry);
    const blockedIds = new Set([...cycleEntries.map((e) => e.id), ...blockedByMissing.map((e) => e.id)]);
    const final = ordered.map((e) => blockedIds.has(e.id) ? { ...e, status: 'blocked', error: 'missing or circular dependency' } : e);
    await rt.store.replace(final);
    await rt.store.pruneHistory(settings['history.retentionCount'] ?? 100);
    return final;
}
function publishQueue(rt, active) {
    rt.context.publish('issue-queue-panel', 'queue', active);
    rt.context.publish('issue-queue-panel', 'autoScan', {
        enabled: !rt.paused && rt.timer != null,
        lastScanAt: rt.lastScanAt,
        nextScanAt: rt.paused || !rt.timer ? null : nextScanAtIso(rt),
        intervalMinutes: readSettingsFromContext(rt.context)['scan.refreshMinutes'] ?? 30,
    });
    const settings = readSettingsFromContext(rt.context);
    rt.context.publish('issue-queue-panel', 'state', { dryRun: Boolean(settings.dryRun) });
}
function nextScanAtIso(rt) {
    if (!rt.timer)
        return null;
    const settings = readSettingsFromContext(rt.context);
    const minutes = settings['scan.refreshMinutes'] ?? 30;
    return new Date(Date.now() + minutes * 60_000).toISOString();
}
/**
 * Reserve the worker slots and start the reserved work.
 *
 * The reservation is EXCLUSIVE and durable: it happens inside the
 * control-plane store's serialized read-modify-write, so two concurrent
 * callers cannot reserve the same issue. The chain engine is NOT touched:
 * the control plane only decides WHAT runs, the engine advances the chain
 * of a running session.
 *
 * FAIL CLOSED: an issue whose session cannot be created is marked failed
 * in the registry, and the slot is released for the next candidate.
 */
/**
 * Mirror the leases reclaimed in the control plane onto the legacy queue.
 *
 * `reclaimExpiredLeases` blocks the items whose lease expired inside the
 * control plane. The legacy entry is written from that authority, so the
 * two views cannot drift.
 */
async function mirrorReclaimedLeases(rt) {
    const state = await rt.controlPlane.read((s) => s);
    const active = await rt.store.loadActive();
    for (const entry of active) {
        const key = `${entry.repoKey}#${entry.issueNumber}`;
        const item = state.items[key];
        if (!item)
            continue;
        // Only the items the control plane blocked because their lease
        // expired need a mirror; the others are handled by their own writer.
        if (item.status !== 'blocked')
            continue;
        if (!item.error?.startsWith('lease expired'))
            continue;
        if (entry.status === 'blocked')
            continue;
        const patched = syncQueueStatus(entry, item);
        try {
            await rt.store.transitionTo(entry.id, patched.status, {
                ...(patched.error ? { error: patched.error } : {}),
                finishedAt: new Date().toISOString(),
            });
        }
        catch {
            // The store may refuse the transition (e.g. running → blocked is
            // allowed, but a terminal entry is not); the drift detector reports
            // it.
        }
    }
}
/**
 * Reserve ONE issue in the control plane.
 *
 * The reservation is exclusive and scoped to this issue: a bulk
 * `reserve(state, options)` would reserve EVERY eligible issue, and the
 * ones that were not started immediately would stay 'reserved' with no
 * session — and since `reserve` only selects 'queued' items, they could
 * never be scheduled again.
 *
 * Returns false when the issue is already held or the capacity is
 * reached.
 */
async function reserveSingleIssue(rt, entry, options) {
    const key = `${entry.repoKey}#${entry.issueNumber}`;
    return await rt.controlPlane.mutate((state) => {
        const existing = state.items[key];
        if (existing?.status === 'reserved' || existing?.status === 'running')
            return false;
        // The issue may not be in the registry yet (it was added manually):
        // admit it first so the reservation has something to attach to.
        if (!existing) {
            admit(state, [
                {
                    repoKey: entry.repoKey,
                    projectId: entry.projectId,
                    issueNumber: entry.issueNumber,
                    title: entry.title,
                    url: entry.url,
                    labels: entry.labels,
                    dependsOn: entry.dependsOn,
                },
            ]);
        }
        const item = state.items[key];
        if (!item)
            return false;
        // The DEPENDENCY GATE: an issue may only run when every dependency is
        // done. Without it the legacy path could start an issue whose
        // prerequisite was missing (the control plane's own `reserve` applies
        // the gate, but this path reserved the item directly).
        const deps = dependencyState(state, item);
        if (!deps.satisfied) {
            if (deps.missing.length > 0) {
                item.status = 'blocked';
                item.error = `missing dependency: ${deps.missing.join(', ')}`;
                item.updatedAt = new Date().toISOString();
                state.updatedAt = item.updatedAt;
            }
            return false;
        }
        const active = Object.values(state.items).filter((i) => i.status === 'running' || i.status === 'reserved');
        if (active.length >= options.maxWorkers)
            return false;
        if (active.filter((i) => i.repoKey === item.repoKey).length >= options.maxWorkersPerRepo)
            return false;
        item.status = 'reserved';
        item.attempt += 1;
        item.leaseExpiresAt = Date.now() + options.leaseMs;
        item.updatedAt = new Date().toISOString();
        state.updatedAt = item.updatedAt;
        return true;
    });
}
/**
 * Reserve the worker slots and start the reserved work.
 *
 * The reservation is EXCLUSIVE and durable: it happens inside the
 * control-plane store's serialized read-modify-write, so two concurrent
 * callers cannot reserve the same issue. The chain engine is NOT touched:
 * the control plane only decides WHAT runs, the engine advances the chain
 * of a running session.
 *
 * FAIL CLOSED: an issue whose session cannot be created is marked failed
 * in the registry, and the slot is released for the next candidate.
 */
async function scheduleControlPlane(rt) {
    const settings = readSettingsFromContext(rt.context);
    const options = controlPlaneOptionsFromSettings(settings);
    const dryRun = Boolean(settings.dryRun);
    // A dry run must NOT reserve anything: a reservation without a session
    // is an orphan that blocks the queue once the dry run is turned off.
    if (dryRun) {
        const queued = await rt.controlPlane.read((state) => Object.values(state.items).filter((i) => i.status === 'queued').length);
        rt.context.logger.info(`[DRY RUN] would schedule ${queued} issue(s); nothing was reserved`);
        return 0;
    }
    const reserved = await rt.controlPlane.mutate((state) => reserve(state, options).reserved);
    // `reserve` RECLAIMS the expired leases inside the control plane (an
    // item whose lease expired becomes 'blocked'). The legacy entry must be
    // mirrored, otherwise the two views disagree: the control plane said
    // 'blocked' while the entry still said 'running', forever.
    await mirrorReclaimedLeases(rt);
    if (reserved.length === 0)
        return 0;
    let started = 0;
    for (const item of reserved) {
        try {
            // The control plane must reuse the chain engine, not duplicate it:
            // the issue is written to the legacy queue and spawned through
            // `spawnEntry`, which creates the session AND launches the chain.
            // Spawning the session directly here produced a session the chain
            // engine could never see.
            //
            // The control plane keys an issue by `<repoKey>#<issueNumber>` while
            // the legacy queue uses its own entry id. The EXISTING queue entry is
            // reused when there is one, so the two views stay consistent.
            const active = await rt.store.loadActive();
            const existing = active.find((e) => e.repoKey === item.repoKey && e.issueNumber === item.issueNumber);
            const queueEntry = existing ?? {
                id: item.key,
                repoKey: item.repoKey,
                projectId: item.projectId,
                issueNumber: item.issueNumber,
                title: item.title,
                body: '',
                url: item.url,
                labels: [],
                comments: [],
                dependsOn: item.dependsOn,
                status: 'queued',
                position: 0,
                addedAt: new Date().toISOString(),
            };
            if (!existing) {
                await rt.store.update(queueEntry);
            }
            const spawned = await spawnEntry(rt, { ...queueEntry, status: 'queued' });
            if (spawned.status === 'running') {
                started += 1;
            }
            else {
                await rt.controlPlane.mutate((state) => {
                    completeItem(state, item.key, 'failed', { error: spawned.error ?? 'could not start' });
                });
            }
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // Fail closed: the slot is released, the issue is recorded as failed.
            await rt.controlPlane.mutate((state) => {
                completeItem(state, item.key, 'failed', { error: message });
            });
            rt.context.logger.error(`control plane: could not start ${item.key}: ${message}`);
        }
    }
    return started;
}
/**
 * Spawn the next queued issue, honouring the control plane.
 *
 * The control plane is the ONLY scheduler. The legacy path used to spawn
 * on its own, so an issue could get TWO sessions: one from the control
 * plane and one from here (both schedulers saw the same queue). The
 * reservation is now taken BEFORE the session is created and is released
 * if the creation fails, so a second caller finds the issue already
 * reserved and skips it.
 */
/**
 * Allocate a unique issue number for a manually added issue.
 *
 * The number must be unique per repository: the control plane keys an
 * issue by `<repoKey>#<issueNumber>`, so two manual entries sharing a
 * number would be treated as the same issue.
 */
async function nextManualIssueNumber(rt, repoKey) {
    const active = await rt.store.loadActive();
    const used = new Set(active.filter((e) => e.repoKey === repoKey).map((e) => e.issueNumber));
    // Start from the current time (stable and sortable) and walk forward
    // until the number is free.
    let candidate = Date.now();
    while (used.has(candidate)) {
        candidate += 1;
    }
    return candidate;
}
/**
 * Report every divergence between the control plane (the authority) and
 * the legacy queue (the mirror).
 *
 * The detector existed but was never called from the runtime, so a drift
 * was invisible in production. It is called on every status read and
 * logged as a warning.
 */
async function collectDivergences(rt) {
    const active = await rt.store.loadActive();
    const state = await rt.controlPlane.read((s) => s);
    const divergences = [];
    for (const entry of active) {
        const key = `${entry.repoKey}#${entry.issueNumber}`;
        const item = state.items[key];
        if (!item)
            continue;
        const divergence = findDivergence(entry, item);
        if (divergence)
            divergences.push(`${key}: ${divergence}`);
    }
    return divergences;
}
async function pickAndSpawnNext(rt) {
    const settings = readSettingsFromContext(rt.context);
    const options = controlPlaneOptionsFromSettings(settings);
    const dryRun = Boolean(settings.dryRun);
    const active = await rt.store.loadActive();
    const runningCount = active.filter((e) => e.status === 'running').length;
    if (runningCount >= options.maxWorkers)
        return null;
    const runningByRepo = new Map();
    for (const e of active) {
        if (e.status === 'running')
            runningByRepo.set(e.repoKey, (runningByRepo.get(e.repoKey) ?? 0) + 1);
    }
    for (const entry of active) {
        if (entry.status !== 'queued')
            continue;
        const perRepoCount = runningByRepo.get(entry.repoKey) ?? 0;
        if (perRepoCount >= options.maxWorkersPerRepo)
            continue;
        if (dryRun) {
            rt.context.logger.info(`[DRY RUN] would spawn session for ${entry.repoKey}#${entry.issueNumber}`);
            return entry;
        }
        // Reserve the issue in the control plane BEFORE creating the session.
        // The reservation is exclusive and scoped to THIS issue only: a bulk
        // reservation left the issues that were not started here 'reserved'
        // with no session, and the queue could never be scheduled again.
        const key = `${entry.repoKey}#${entry.issueNumber}`;
        const reserved = await reserveSingleIssue(rt, entry, options);
        if (!reserved)
            continue;
        try {
            return await spawnEntry(rt, entry);
        }
        catch (err) {
            // Fail closed: release the reservation so the issue is not stuck.
            const message = err instanceof Error ? err.message : String(err);
            await rt.controlPlane.mutate((state) => {
                completeItem(state, key, 'failed', { error: message });
            });
            throw err;
        }
    }
    return null;
}
async function spawnEntry(rt, entry) {
    const settings = readSettingsFromContext(rt.context);
    const chain = resolveChain(entry, settings);
    const updated = {
        ...entry,
        status: 'running',
        startedAt: new Date().toISOString(),
        executionStack: chain.map((id) => ({
            workflowId: id,
            workflowName: id,
            status: 'pending',
            retryCount: 0,
        })),
    };
    await rt.store.update(updated);
    try {
        // The ORCHESTRATION PORT resolves the host: `context.host`, the
        // legacy in-process surface, or the supported HTTP API. Passing the
        // port here is what makes the session creation work on a real host,
        // where no in-process surface exists.
        const session = await spawnSessionFor(updated, { orchestration: rt.orchestration });
        if (session.id)
            updated.sessionId = session.id;
        // The CONTROL PLANE is the authority for the scheduling state: the
        // issue becomes 'running' there, and the legacy entry mirrors it.
        if (session.id) {
            await rt.controlPlane.mutate((state) => {
                markRunning(state, `${entry.repoKey}#${entry.issueNumber}`, session.id);
            });
        }
        if (chain.length > 0) {
            // startChain returns a stack with the first workflow marked running —
            // assign it back so subsequent reads (RPC, hooks, store) see the
            // running status immediately, before the workflow fires its first
            // workflow.execution.changed event.
            updated.executionStack = startChain(updated, createLaunchDriver(rt), {
                sessionId: updated.sessionId ?? '',
            });
        }
        await rt.store.update(updated);
    }
    catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        // The CONTROL PLANE is the authority: it must learn about the failure
        // too. Writing only the legacy entry left the control plane saying
        // 'reserved' while the entry said 'failed' — a drift, and an orphan
        // reservation that blocked the queue.
        const key = `${entry.repoKey}#${entry.issueNumber}`;
        await rt.controlPlane.mutate((state) => {
            if (!state.items[key]) {
                admit(state, [
                    {
                        repoKey: entry.repoKey,
                        projectId: entry.projectId,
                        issueNumber: entry.issueNumber,
                        title: entry.title,
                        url: entry.url,
                        labels: entry.labels,
                        dependsOn: entry.dependsOn,
                    },
                ]);
            }
            completeItem(state, key, 'failed', { error: err });
        });
        const item = await rt.controlPlane.read((state) => state.items[key]);
        const patched = syncQueueStatus(updated, item);
        updated.status = patched.status;
        updated.error = patched.error ?? err;
        updated.finishedAt = new Date().toISOString();
        await rt.store.update(updated);
        rt.context.notify({
            title: { en: 'Spawn failed', fr: 'Échec du spawn' },
            body: { en: err, fr: err },
            level: 'error',
        });
    }
    return updated;
}
function createLaunchDriver(rt) {
    return {
        launch: (p) => {
            try {
                rt.orchestration.launchWorkflow({
                    sessionId: p.sessionId,
                    workflowId: p.workflowId,
                    params: p.params,
                    content: p.content,
                    projectId: p.projectId,
                });
            }
            catch (err) {
                rt.context.logger.error(`launchWorkflow failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        },
    };
}
async function healthCheck(rt, context) {
    const settings = readSettingsFromContext(context);
    const token = settings['github.token'] ?? '';
    const signal = rt.abortController.signal;
    const tokenRes = token
        ? await validateToken(token, signal)
        : { valid: false, rateLimit: { remaining: 0, resetAt: null } };
    const repos = parseRepoMapping(settings['repos.mapping']);
    const reposAccessible = {};
    for (const { repoKey } of repos) {
        const [owner, repo] = repoKey.split('/', 2);
        if (!owner || !repo || !token) {
            reposAccessible[repoKey] = 'unknown';
            continue;
        }
        const res = await getIssue(token, owner, repo, 1, signal);
        if (res.status === 404)
            reposAccessible[repoKey] = '404';
        else if (res.status === 403)
            reposAccessible[repoKey] = '403';
        else if (res.ok)
            reposAccessible[repoKey] = 'ok';
        else
            reposAccessible[repoKey] = 'unknown';
    }
    const workflows = {};
    for (const wf of parseChain(settings['workflows.chain'])) {
        workflows[wf] = 'ok';
    }
    const projects = {};
    for (const { repoKey, projectId } of repos) {
        projects[`${repoKey}→${projectId}`] = projectId ? 'ok' : 'missing';
    }
    const mappingIssues = [];
    for (const line of (settings['repos.mapping'] ?? '').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#'))
            continue;
        if (!trimmed.includes('=') || !trimmed.split('=')[0]?.includes('/')) {
            mappingIssues.push(`malformed line: ${trimmed}`);
        }
    }
    const internal = await getHostInternal(context);
    const hasFacade = internal?.kind === 'facade';
    const hasLegacy = internal?.kind === 'legacy';
    return {
        github: { tokenValid: tokenRes.valid, rateLimitRemaining: tokenRes.rateLimit.remaining, reposAccessible },
        openFoxInternals: {
            sessionManager: internal ? 'ok' : 'missing',
            launchWorkflowRun: hasLegacy ? 'ok' : hasFacade ? 'ok' : 'missing',
            host: hasFacade ? 'ok' : 'missing',
        },
        workflows,
        projects,
        mapping: { valid: mappingIssues.length === 0, issues: mappingIssues },
    };
}
export function register(registry) {
    const context = registry.context;
    // If a previous runtime is still registered (host hot-reload, caller
    // forgot to deactivate, …) tear it down so its timer and in-flight
    // fetches don't outlive the new runtime. Without this, overwriting
    // currentRt below would orphan the previous setInterval handle and
    // its AbortController, leaking timers forever.
    if (currentRt !== null) {
        if (currentRt.timer) {
            clearInterval(currentRt.timer);
            currentRt.timer = null;
        }
        currentRt.abortController.abort();
        currentRt.executions.clear();
        currentRt.appliedExecutionEvents.clear();
    }
    const store = new QueueStore({
        get: async (k) => (await context.storage?.get(k)),
        set: async (k, v) => {
            await context.storage?.set(k, v);
        },
    });
    // The durable control-plane registry lives under its own storage key, so
    // its read-modify-write cycle never races the queue's.
    const controlPlane = new ControlPlaneStore({
        get: async (k) => (await context.storage?.get(k)),
        set: async (k, v) => {
            await context.storage?.set(k, v);
        },
    });
    const settingsReader = () => readSettingsFromContext(context);
    const rt = {
        context,
        settings: settingsReader,
        store,
        timer: null,
        abortController: new AbortController(),
        paused: false,
        lastScanAt: null,
        rateLimitedUntil: null,
        executions: new Map(),
        orchestration: createOrchestration(context),
        appliedExecutionEvents: new Set(),
        controlPlane,
    };
    currentRt = rt;
    registry.registerSettings(settingsSchema);
    registry.registerUiAction({
        id: 'open-issue-queue',
        slot: 'header.actions',
        label: { en: 'Issue Queue', fr: 'Issue Queue' },
        icon: 'puzzle',
        onActivate: { kind: 'openPanel', panelId: 'issue-queue-panel' },
    });
    registry.registerUiPanel({
        id: 'issue-queue-panel',
        title: { en: 'Issue Queue', fr: 'File d’attente d’issues' },
        size: 'xl',
        kind: 'iframe',
        url: 'dist/panel.html',
    });
    registry.registerAsset('dist/panel.html');
    registry.registerRpc(`${RPC_NAMESPACE}ping`, async () => ({
        ok: true,
        plugin: context.id,
        version: context.version,
        timestamp: new Date().toISOString(),
    }));
    registry.registerRpc(`${RPC_NAMESPACE}scanNow`, async () => scanAll(rt));
    registry.registerRpc(`${RPC_NAMESPACE}health`, async () => healthCheck(rt, context));
    // Control-plane introspection: the durable registry and its metrics.
    registry.registerRpc(`${RPC_NAMESPACE}controlPlaneStatus`, async () => {
        const settings = readSettingsFromContext(context);
        const options = controlPlaneOptionsFromSettings(settings);
        // The divergence between the two views is reported, not silently
        // tolerated: the control plane is the authority, so a drift means a
        // writer bypassed it and must be fixed.
        const divergences = await collectDivergences(rt);
        if (divergences.length > 0) {
            context.logger.warn(`control plane: ${divergences.length} divergence(s) between the control plane and the queue`, { divergences });
        }
        return await rt.controlPlane.read((state) => ({
            options,
            metrics: computeControlPlaneMetrics(state, { maxWorkers: options.maxWorkers }),
            items: Object.values(state.items),
            divergences,
        }));
    });
    // Run one scheduling pass: reserve the free worker slots and start the
    // reserved issues. Safe to call repeatedly — the reservation is
    // exclusive, so a second call finds nothing left to reserve.
    registry.registerRpc(`${RPC_NAMESPACE}controlPlaneSchedule`, async () => {
        const started = await scheduleControlPlane(rt);
        return { started };
    });
    registry.registerRpc(`${RPC_NAMESPACE}getQueue`, async (params) => {
        const p = (params ?? {});
        const active = await rt.store.loadActive();
        const text = p.filter?.toLowerCase() ?? '';
        const statuses = new Set(p.statusFilter ?? []);
        return active
            .filter((e) => statuses.size === 0 || statuses.has(e.status))
            .filter((e) => !text || `${e.title} ${e.body} ${e.url}`.toLowerCase().includes(text));
    });
    registry.registerRpc(`${RPC_NAMESPACE}getHistory`, async (params) => {
        const p = (params ?? {});
        const history = await rt.store.loadHistory();
        const limit = p.limit ?? 100;
        const offset = p.offset ?? 0;
        return history.slice(offset, offset + limit);
    });
    registry.registerRpc(`${RPC_NAMESPACE}getMetrics`, async () => {
        const history = await rt.store.loadHistory();
        return computeMetrics(history);
    });
    registry.registerRpc(`${RPC_NAMESPACE}startIssue`, async (params) => {
        const { queueId } = (params ?? {});
        const entry = await rt.store.findById(queueId);
        if (!entry)
            throw new Error(`queue entry not found: ${queueId}`);
        if (entry.status !== 'queued')
            throw new Error(`cannot start entry in status ${entry.status}`);
        // The control plane is the only scheduler: the reservation is taken
        // BEFORE the session is created, so an issue already handled by the
        // control plane is never started a second time.
        const settings = readSettingsFromContext(context);
        const options = controlPlaneOptionsFromSettings(settings);
        const key = `${entry.repoKey}#${entry.issueNumber}`;
        // The SAME single-item reservation as the legacy path: a bulk
        // reservation here left the other issues 'reserved' with no session.
        const reserved = await reserveSingleIssue(rt, entry, options);
        if (!reserved) {
            throw new Error(`issue ${key} is already reserved by the control plane`);
        }
        // `spawnEntry` reports a failure in the returned entry rather than
        // throwing, so the reservation is released here when the entry did not
        // start: the issue must not stay reserved forever.
        const spawned = await spawnEntry(rt, entry);
        if (spawned.status !== 'running') {
            await rt.controlPlane.mutate((state) => {
                completeItem(state, key, 'failed', { error: spawned.error ?? 'could not start' });
            });
        }
        return spawned;
    });
    registry.registerRpc(`${RPC_NAMESPACE}cancelIssue`, async (params) => {
        const { queueId } = (params ?? {});
        const entry = await rt.store.findById(queueId);
        if (!entry)
            throw new Error(`queue entry not found: ${queueId}`);
        if (entry.sessionId) {
            try {
                await rt.orchestration.stopSession(entry.sessionId);
            }
            catch (err) {
                context.logger.warn(`automate.cancelIssue: stopSession failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        // The CONTROL PLANE is the authority for the scheduling state: the
        // legacy entry is updated from it, never the other way round.
        const key = `${entry.repoKey}#${entry.issueNumber}`;
        await rt.controlPlane.mutate((state) => {
            if (!state.items[key]) {
                admit(state, [
                    {
                        repoKey: entry.repoKey,
                        projectId: entry.projectId,
                        issueNumber: entry.issueNumber,
                        title: entry.title,
                        url: entry.url,
                        labels: entry.labels,
                        dependsOn: entry.dependsOn,
                    },
                ]);
            }
            completeItem(state, key, 'cancelled');
        });
        const item = await rt.controlPlane.read((state) => state.items[key]);
        const patched = syncQueueStatus(entry, item);
        return await rt.store.transitionTo(queueId, patched.status, {
            finishedAt: new Date().toISOString(),
            ...(patched.error ? { error: patched.error } : {}),
        });
    });
    registry.registerRpc(`${RPC_NAMESPACE}removeIssue`, async (params) => {
        const { queueId } = (params ?? {});
        const entry = await rt.store.findById(queueId);
        if (!entry)
            throw new Error(`queue entry not found: ${queueId}`);
        // The CONTROL PLANE is the authority: the issue is removed THERE
        // first, so it cannot be scheduled again while the legacy entry still
        // exists.
        const key = `${entry.repoKey}#${entry.issueNumber}`;
        await rt.controlPlane.mutate((state) => {
            delete state.items[key];
            state.updatedAt = new Date().toISOString();
        });
        await rt.store.remove(queueId);
        return { ok: true };
    });
    registry.registerRpc(`${RPC_NAMESPACE}reprocess`, async (params) => {
        const { queueId } = (params ?? {});
        const settings = readSettingsFromContext(context);
        const entry = await rt.store.findById(queueId);
        if (!entry)
            throw new Error(`queue entry not found: ${queueId}`);
        if (!isTerminated(entry.status) && entry.status !== 'blocked') {
            throw new Error(`cannot reprocess entry in status ${entry.status}`);
        }
        // The previous session must be STOPPED before the issue runs again.
        // Reprocessing while the previous session may still be alive created a
        // SECOND session for the same issue — two agents on the same code.
        if (entry.sessionId) {
            try {
                await rt.orchestration.stopSession(entry.sessionId);
            }
            catch (err) {
                context.logger.warn(`automate.reprocess: stopSession failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        const reset = settings['post.reprocessResetsRetryCount'];
        const executionStack = entry.executionStack?.map((s) => reset ? { ...s, retryCount: 0, status: 'pending' } : s);
        // The CONTROL PLANE is the authority: the issue goes back to 'queued'
        // THERE first. Without this the control plane kept the issue 'blocked'
        // while the legacy entry said 'queued', and since `reserve` only
        // selects 'queued' items the issue could never run again.
        const key = `${entry.repoKey}#${entry.issueNumber}`;
        await rt.controlPlane.mutate((state) => {
            if (!state.items[key]) {
                admit(state, [
                    {
                        repoKey: entry.repoKey,
                        projectId: entry.projectId,
                        issueNumber: entry.issueNumber,
                        title: entry.title,
                        url: entry.url,
                        labels: entry.labels,
                        dependsOn: entry.dependsOn,
                    },
                ]);
            }
            const item = state.items[key];
            item.status = 'queued';
            item.sessionId = undefined;
            item.leaseExpiresAt = undefined;
            delete item.error;
            item.updatedAt = new Date().toISOString();
            state.updatedAt = item.updatedAt;
        });
        const updated = {
            ...entry,
            status: 'queued',
            ...(executionStack ? { executionStack } : {}),
        };
        delete updated.startedAt;
        delete updated.finishedAt;
        delete updated.error;
        await rt.store.update(updated);
        await pickAndSpawnNext(rt);
        return updated;
    });
    registry.registerRpc(`${RPC_NAMESPACE}addIssueByUrl`, async (params) => {
        const { url } = (params ?? {});
        const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
        if (!m)
            throw new Error(`invalid GitHub issue URL: ${url}`);
        const [, owner, repo, num] = m;
        if (!owner || !repo || !num)
            throw new Error(`invalid GitHub issue URL: ${url}`);
        const settings = readSettingsFromContext(context);
        const token = settings['github.token'] ?? '';
        const signal = rt.abortController.signal;
        const res = await getIssue(token, owner, repo, Number(num), signal);
        if (!res.ok || !res.data)
            throw new Error(`could not fetch ${url}: ${res.error ?? res.status}`);
        const repos = parseRepoMapping(settings['repos.mapping']);
        const mapping = repos.find((r) => r.repoKey === `${owner}/${repo}`);
        if (!mapping)
            throw new Error(`no project mapping for ${owner}/${repo}`);
        const commentsRes = await listIssueComments(token, owner, repo, Number(num), signal);
        const comments = (commentsRes.data ?? []).map((c) => ({
            author: c.user?.login ?? 'unknown',
            body: c.body,
            createdAt: c.created_at,
        }));
        const labels = res.data.labels.map((l) => (typeof l === 'string' ? l : l.name));
        const entry = {
            id: newEntryId(),
            repoKey: `${owner}/${repo}`,
            projectId: mapping.projectId,
            issueNumber: res.data.number,
            title: res.data.title,
            body: res.data.body ?? '',
            url: res.data.html_url,
            labels,
            comments,
            dependsOn: [],
            status: 'queued',
            position: 0,
            addedAt: new Date().toISOString(),
        };
        const { added } = await rt.store.addNew([entry]);
        await orderAndStore(rt);
        return added[0] ?? entry;
    });
    registry.registerRpc(`${RPC_NAMESPACE}addIssueRaw`, async (params) => {
        const p = (params ?? {});
        const settings = readSettingsFromContext(context);
        const repos = parseRepoMapping(settings['repos.mapping']);
        const mapping = repos.find((r) => r.repoKey === p.repoKey);
        if (!mapping)
            throw new Error(`no project mapping for ${p.repoKey}`);
        // A manual entry has no GitHub issue number. `Date.now()` was used, but
        // two calls in the same millisecond produced the SAME number — and the
        // control plane keys an issue by `<repoKey>#<issueNumber>`, so the
        // second entry was seen as a duplicate of the first and could never
        // be scheduled. A monotonic counter keeps the keys unique.
        const issueNumber = await nextManualIssueNumber(rt, p.repoKey);
        const entry = {
            id: newEntryId(),
            repoKey: p.repoKey,
            projectId: mapping.projectId,
            issueNumber,
            title: p.title,
            body: p.body,
            url: '',
            labels: p.labels ?? [],
            comments: [],
            dependsOn: [],
            status: 'queued',
            position: 0,
            addedAt: new Date().toISOString(),
        };
        const { added } = await rt.store.addNew([entry]);
        await orderAndStore(rt);
        return added[0] ?? entry;
    });
    registry.registerRpc(`${RPC_NAMESPACE}pauseAutoScan`, async () => {
        rt.paused = true;
        publishQueue(rt, await rt.store.loadActive());
        return { paused: true };
    });
    registry.registerRpc(`${RPC_NAMESPACE}resumeAutoScan`, async () => {
        rt.paused = false;
        publishQueue(rt, await rt.store.loadActive());
        return { paused: false };
    });
    function safeHook(name, fn) {
        return (async (...args) => {
            try {
                await fn(...args);
            }
            catch (err) {
                context.logger.error(`hook ${name} failed`, {
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        });
    }
    registry.registerHook('tool.completed', safeHook('tool.completed', async (payload) => {
        // The host nests the tool output under `data.result.output`; the
        // adapter also accepts the legacy flat `{ sessionId, output }` shape.
        const sessionId = readSessionId(payload);
        const output = extractToolOutputText(payload);
        if (!sessionId || !output)
            return;
        const settings = readSettingsFromContext(context);
        const re = new RegExp(settings['pr.urlRegex'] ?? 'https://github\\.com/[^/]+/[^/]+/pull/(\\d+)', 'i');
        const match = re.exec(output);
        if (!match)
            return;
        const active = await rt.store.loadActive();
        const entry = active.find((e) => e.sessionId === sessionId);
        if (!entry || entry.prUrl)
            return;
        entry.prUrl = match[0];
        await rt.store.update(entry);
        publishQueue(rt, await rt.store.loadActive());
    }));
    registry.registerHook('workflow.execution.changed', safeHook('workflow.execution.changed', async (payload) => {
        // The host nests the workflow fields under `data` and uses the status
        // vocabulary 'running' | 'waiting' | 'completed' | 'cancelled' |
        // 'blocked'. The adapter normalises it; an incomplete payload is
        // ignored without launching anything.
        const normalized = normalizeWorkflowExecutionPayload(payload);
        if (!normalized)
            return;
        const active = await rt.store.loadActive();
        const entry = active.find((e) => e.sessionId === normalized.sessionId);
        if (!entry)
            return;
        const outcome = processWorkflowEvent(entry, {
            sessionId: normalized.sessionId,
            workflowId: normalized.workflowId,
            executionId: normalized.executionId,
            status: normalized.status,
        }, {
            appliedExecutionEvents: rt.appliedExecutionEvents,
            log: (msg) => context.logger.warn(msg),
            buildIssueContext,
            buildIssueParams,
        });
        if (outcome.deduplicated)
            return;
        for (const launch of outcome.launches) {
            rt.orchestration.launchWorkflow({
                sessionId: launch.sessionId,
                workflowId: launch.workflowId,
                params: launch.params,
                content: launch.content,
                projectId: launch.projectId,
            });
        }
        if (outcome.transitionTo === 'done' || outcome.transitionTo === 'blocked') {
            // The CONTROL PLANE is the single authority for the scheduling
            // state. The legacy queue entry is updated afterwards from that
            // authority, so the two views cannot drift: there is one writer
            // for `status`, not two.
            const key = `${entry.repoKey}#${entry.issueNumber}`;
            const status = outcome.transitionTo;
            const reason = status === 'blocked'
                ? (outcome.blockedReason ?? `workflow ${normalized.workflowId} blocked`)
                : undefined;
            await rt.controlPlane.mutate((state) => {
                // The authority ADOPTS an issue it does not know yet (it was
                // added manually, or the registry was lost): the scheduling
                // state must never be written to the legacy queue alone.
                if (!state.items[key]) {
                    admit(state, [
                        {
                            repoKey: entry.repoKey,
                            projectId: entry.projectId,
                            issueNumber: entry.issueNumber,
                            title: entry.title,
                            url: entry.url,
                            labels: entry.labels,
                            dependsOn: entry.dependsOn,
                        },
                    ]);
                }
                completeItem(state, key, status, reason ? { error: reason } : {});
            });
            const item = await rt.controlPlane.read((state) => state.items[key]);
            const patched = syncQueueStatus(entry, item);
            await rt.store.transitionTo(entry.id, patched.status, {
                executionStack: entry.executionStack ?? [],
                finishedAt: new Date().toISOString(),
                ...(patched.error ? { error: patched.error } : {}),
            });
            if (status === 'done') {
                await maybePostProcess(rt, entry);
                await pickAndSpawnNext(rt);
            }
            else {
                context.notify({
                    title: { en: 'Workflow blocked', fr: 'Workflow bloqué' },
                    body: {
                        en: `Issue #${entry.issueNumber} needs intervention`,
                        fr: `Issue #${entry.issueNumber} demande intervention`,
                    },
                    level: 'error',
                });
            }
        }
        else {
            // Persist the mutated execution stack on EVERY path.
            //
            // `processWorkflowEvent` mutates `entry.executionStack` in place. The
            // chain-advance branch (a workflow completed, the next one launched)
            // used to fall through without persisting it: with the real host
            // storage (JSON round-trip) the in-place mutation was then LOST, so
            // the next step stayed 'pending', the engine found no 'running' step
            // on the following event, and the chain stalled after the first
            // workflow.
            await rt.store.update({
                ...entry,
                ...(entry.executionStack ? { executionStack: entry.executionStack } : {}),
            });
        }
        publishQueue(rt, await rt.store.loadActive());
    }));
    registry.registerHook('task.completed', safeHook('task.completed', async () => {
        await pickAndSpawnNext(rt);
        publishQueue(rt, await rt.store.loadActive());
    }));
    // Budget accounting. The host reports the token usage of every LLM call
    // through `llm.completed`; the usage is attributed to the issue the
    // session is working on, so the per-issue budget and the cache ratio can
    // be observed without any extra LLM call.
    registry.registerHook('llm.completed', safeHook('llm.completed', async (payload) => {
        const sessionId = readSessionId(payload);
        if (!sessionId)
            return;
        const data = payload?.data ?? {};
        const num = (key) => {
            const value = Number(data[key]);
            return Number.isFinite(value) ? value : 0;
        };
        const budget = controlPlaneOptionsFromSettings(readSettingsFromContext(context)).maxTokensPerIssue;
        const blocked = await rt.controlPlane.mutate((state) => {
            const item = recordTokenUsage(state, sessionId, {
                promptTokens: num('promptTokens'),
                completionTokens: num('completionTokens'),
                totalTokens: num('totalTokens'),
                cachedPromptTokens: num('cachedPromptTokens'),
                cacheWriteTokens: num('cacheWriteTokens'),
                llmCalls: 1,
            }, { maxTokensPerIssue: budget });
            // The budget can block the item IN the control plane. The legacy
            // entry must be mirrored, or the two views disagree.
            return item?.status === 'blocked' ? item : null;
        });
        if (blocked) {
            const active = await rt.store.loadActive();
            const entry = active.find((e) => e.sessionId === sessionId);
            if (entry && entry.status !== 'blocked') {
                const patched = syncQueueStatus(entry, blocked);
                try {
                    await rt.store.transitionTo(entry.id, patched.status, {
                        ...(patched.error ? { error: patched.error } : {}),
                    });
                }
                catch {
                    // The store may refuse the transition; the drift detector
                    // reports it.
                }
            }
        }
    }));
    registry.registerTool({
        name: 'issue_queue_list',
        description: 'Returns the current active issue queue with status, position, repo, and current workflow step.',
        parameters: {
            type: 'object',
            properties: { statusFilter: { type: 'array', items: { type: 'string' } } },
        },
        execute: async (args) => {
            const p = (args ?? {});
            const active = await rt.store.loadActive();
            const statuses = new Set(p.statusFilter ?? []);
            const filtered = statuses.size === 0 ? active : active.filter((e) => statuses.has(e.status));
            return {
                success: true,
                output: JSON.stringify(filtered.map((e) => ({
                    id: e.id,
                    issueNumber: e.issueNumber,
                    title: e.title,
                    status: e.status,
                    position: e.position,
                    repoKey: e.repoKey,
                }))),
            };
        },
    });
    registry.registerTool({
        name: 'issue_queue_status',
        description: 'Returns the detailed status of one queue entry by id.',
        parameters: { type: 'object', properties: { queueId: { type: 'string' } }, required: ['queueId'] },
        execute: async (args) => {
            const p = (args ?? {});
            const entry = await rt.store.findById(p.queueId);
            if (!entry)
                return { success: false, error: `queue entry not found: ${p.queueId}` };
            return { success: true, output: JSON.stringify(entry) };
        },
    });
    async function maybePostProcess(rt, entry) {
        const settings = readSettingsFromContext(rt.context);
        if (!hasAnyPostToggle(settings))
            return;
        const token = settings['github.token'];
        if (!token)
            return;
        const [owner, repo] = entry.repoKey.split('/', 2);
        if (!owner || !repo)
            return;
        if (rt.abortController.signal.aborted)
            return;
        const signal = rt.abortController.signal;
        const me = settings['post.assignOnSuccess'] ? await fetchAuthenticatedLogin(token, signal) : undefined;
        if (rt.abortController.signal.aborted)
            return;
        await postProcess(entry, settings, {
            summary: `OpenFox chain completed for #${entry.issueNumber}`,
            sessionUrl: '',
            prUrl: entry.prUrl ?? '',
            ...(me ? { me } : {}),
        }, { token, owner, repo, signal: rt.abortController.signal });
    }
    async function startTimer() {
        const settings = readSettingsFromContext(context);
        const minutes = settings['scan.refreshMinutes'] ?? 30;
        if (rt.timer)
            clearInterval(rt.timer);
        rt.timer = setInterval(() => {
            if (rt.paused)
                return;
            void scanAll(rt).then(() => monitorAndPublish());
        }, minutes * 60_000);
    }
    async function monitorAndPublish() {
        const settings = readSettingsFromContext(context);
        if (!settings['pr.monitorEnabled'])
            return;
        const token = settings['github.token'];
        if (!token)
            return;
        if (rt.abortController.signal.aborted)
            return;
        const { monitorPRs } = await import('./pr-monitor.js');
        const result = await monitorPRs({
            token,
            store: rt.store,
            notify: (n) => context.notify(n),
            republish: () => {
                void rt.store.loadActive().then((q) => publishQueue(rt, q));
            },
            signal: rt.abortController.signal,
            // The PR monitor updates the control plane (the authority) and the
            // legacy entry is written from it.
            controlPlane: rt.controlPlane,
        });
        if (result.checked > 0 || result.errors.length > 0) {
            context.logger.info(`pr-monitor: checked=${result.checked} completed=${result.completed} failed=${result.failed} errors=${result.errors.length}`);
        }
    }
    void startTimer();
    if (readSettingsFromContext(context)['scan.startupScan']) {
        void scanAll(rt).then(() => monitorAndPublish());
    }
    void orderAndStore(rt);
    void publishQueue(rt, []);
    context.logger.info('openfox-automate registered');
}
export function deactivate() {
    // The host expects a clean lifecycle on disable / uninstall: stop the
    // periodic scan timer and cancel any in-flight fetches started under
    // the active AbortController. We keep a module-level reference to the
    // current runtime so this cleanup can actually reach the handles that
    // register() put in place.
    const rt = currentRt;
    currentRt = null;
    if (!rt)
        return;
    if (rt.timer) {
        clearInterval(rt.timer);
        rt.timer = null;
    }
    // AbortController.abort() is idempotent: a second call is a no-op and
    // does not throw, so no try/catch is needed.
    rt.abortController.abort();
    // Drop the dedup set and executions map so a future enable starts fresh
    // even if the host re-uses the module instance.
    rt.executions.clear();
    rt.appliedExecutionEvents.clear();
}
export default { register, deactivate };
//# sourceMappingURL=index.js.map