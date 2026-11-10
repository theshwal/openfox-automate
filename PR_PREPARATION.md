# PR preparation — openfox-automate

**Status: NOT PUBLISHED.** No push, no PR, no merge, no deploy, no install.
Prepared locally on an isolated branch for review.

---

## 1. Real base

The branch was originally built on `b37a23a`, but `origin/main` has moved
on since: it now carries `7b03421` (merge of `chore/pr-contract-v1`,
which added `.github/delivery-policy.yml`, `docs/delivery-policy-v1.md`,
`schemas/delivery-policy-v1.schema.json` and the `src/constants.ts`
RPC namespace).

A merge test against the real base produced **conflicts on `src/index.ts`
and on the generated `dist/*` maps**. The `src/index.ts` conflict was a
real one, not a textual accident:

> `origin/main` renamed every RPC method to a namespaced convention
> (`src/constants.ts`: `RPC_NAMESPACE = 'automate.'`), e.g.
> `scan_now` → `automate.scanNow`, `start_issue` → `automate.startIssue`.

The branch has therefore been **rebased onto `origin/main`** (7 commits,
see §3). The two new control-plane RPCs follow the same convention
(`automate.controlPlaneStatus`, `automate.controlPlaneSchedule`), and the
tests address the namespaced methods. The `dist/*` conflicts were
resolved by regenerating `dist/` from source, which is the correct
resolution for build output.

**Preparation branch:** `feat/host-event-adapters-v2` @ `a246b16`
(worktree `/tmp/ofx-worktrees/rebase`).

## 2. Final diff

```
74 files changed, 7755 insertions(+), 403 deletions(-)
```

Source only (the rest is `dist/`, which is committed build output):

| File | Change |
|---|---|
| `src/host-events.ts` | NEW (156) — host event payload adapters |
| `src/host-client.ts` | NEW (330) — supported host HTTP client, fail-closed |
| `src/control-plane.ts` | NEW (503) — durable control plane |
| `src/control-plane-store.ts` | NEW (102) — durable store, serialized writes |
| `src/index.ts` | +363/−… — wiring, one scheduler, budget hook |
| `src/chain.ts` | +94/−… — host status vocabulary, resume fix, relevance guard |
| `src/ordering.ts` | +20 — empty-pattern hang fix |
| `src/settings.ts` | +60/−… — safe defaults, new settings, clamps |
| `src/types.ts` | +17/−… — new settings keys and defaults |
| `src/state-ownership.ts` | NEW (103) — single authority for the scheduling state |
| `src/resolve-openfox.ts` | −119/+… — the fragile internals import removed |

## 3. Commits (9, in review order)

| # | Commit | Scope |
|---|---|---|
| 1 | `e478259` `fix(host-events)` | adapt `workflow.execution.changed` / `tool.completed` to the real host payloads |
| 2 | `0649100` `fix(persistence,packaging)` | persist the chain advance; make the build real |
| 3 | `23f4471` `feat(host-client,simulation)` | supported host client; vertical simulation; fix a scan hang |
| 4 | `c59fc00` `feat(control-plane)` | durable multi-issue control plane with budgets and leases |
| 5 | `64c95a0` `fix(safety)` | one scheduler, no duplicate session, fail-closed lease and budget |
| 6 | `8c21237` `feat(host-contract)` | pin the 2.0.161 host contracts; harden the base URL |
| 7 | `e10e7b6` `test` | adapt the RPC names to the namespaced convention of main |
| 8 | `b963c72` `refactor(state)` | one source of truth; the fragile internals import removed |
| 9 | `a246b16` `docs` | the resolver header describes the resolver as it now is |

## 4. Recommended PR segmentation

The branch is one coherent stack, but it is **7 commits / 6 265 lines** —
too large for a single reviewable PR. Recommended: **3 PRs**, in this
order, each independently green.

### PR 1 — `fix: make the plugin work with the real OpenFox host`
Commits 1 + 2. 1 414 insertions / 162 deletions. *Correctness only, no new
capability.*
- The plugin read the workflow fields at the root of the host payload;
  they live under `data`. `payload.status` was `undefined`, so the chain
  never advanced.
- The host's status vocabulary is `running | waiting | completed |
  cancelled | blocked` — never `done`.
- The tool output lives in `data.result.output`, so no PR URL was ever
  captured.
- The chain advance was never persisted (the host storage is a JSON
  round-trip), so the chain stalled after the first workflow.
- `npm run build` was a no-op when `dist/` existed, so the shipped
  artefact was stale and still carried the unresolvable `Plan Issue v2`
  display names.
- Also fixes an infinite loop: an empty `ordering.dependencyPattern`
  compiled to a regex that matches the empty string at every position and
  froze the host on every scan.

**Reviewer focus:** the event contracts. Highest risk of the whole stack,
lowest conceptual surface.

### PR 2 — `feat: durable control plane and supported host client`
Commits 3 + 4. 3 755 insertions / 17 deletions. *New capability, isolated
behind its own RPCs.*
- `src/host-client.ts`: the host exposes **no** session/workflow API to
  plugins (no `host`, no `openFoxInternals` in `PluginContext`; the public
  package exports do not expose `sessionManager`/`launchWorkflowRun`).
  The client therefore uses the host's documented local HTTP API and the
  host's own `/<workflow-id> <params>` launch syntax. Fail-closed, no
  internal imports, loopback-only base URL.
- `src/control-plane.ts` + store: durable registry (admission, priority,
  dependencies, exclusive reservation, leases, per-issue token budgets,
  metrics), all pure and LLM-free.
- New RPCs `automate.controlPlaneStatus` / `automate.controlPlaneSchedule`.

**Reviewer focus:** the control-plane invariants. The host's own task
board is not reachable from a plugin, so this is a *functional* duplicate
of the host's scheduling — deliberate, and documented in the module.

### PR 3 — `fix: single scheduler, fail-closed safety, safe defaults`
Commits 5 + 6 + 7 + 8 + 9. *Hardening and structural cleanup; can be
merged last or squashed into PR 2.*
- one scheduler, no duplicate session;
- expired lease blocks instead of duplicating;
- the token budget stops a live run;
- safe defaults (`dryRun` on, no startup scan);
- the host contract tests and the base-URL hardening;
- the RPC names follow the namespace introduced on `main`;
- **one source of truth** for the scheduling state (`src/state-ownership.ts`);
- **the fragile internals import removed** (`resolve-openfox.ts` used to
  import `dist/server/session` / `dist/server/runner`, paths that do not
  exist in the published package).
- One scheduler only: the control plane writes to the legacy queue and
  spawns through the chain engine; `start_issue` and the legacy path
  refuse an issue the control plane already holds. A test showed **2
  sessions for 1 issue** before the fix.
- An expired lease **blocks** the issue instead of re-queueing it (the
  host session may still be running).
- The token budget stops a **live** run.
- `clampSettings` applied on the real path → the worker ceiling of 5 is
  enforced everywhere.
- Safe defaults: `dryRun` **true**, `scan.startupScan` **false**, no
  GitHub write, no auto-merge path.
- The host contract tests pin the 2.0.161 routes and error codes.
- The RPC names follow the namespace introduced on `main`.

**Reviewer focus:** the safety properties and the defaults.

### Files deliberately excluded from all PRs

- `.openfox/` — untracked local multi-repo config, not part of the plugin.
- The uncommitted work in the primary checkout
  (`src/{chain,index,settings,types}.ts`, `test/{chain,settings,state-machine}.test.ts`).
  It is the user's local work: it is **already incorporated** in this
  branch (the `plan-issue-v3` chain ids, the `issue_ref` parameter, the
  settings description) and must not be committed from the primary
  checkout. **The primary checkout must not be touched.**
- `README.md` / `README.fr.md` / `CHANGELOG.md` — these still describe the
  old `openFoxInternals` API and the v2 workflow names. They need a
  separate documentation PR that reflects the final API; doing it here
  would mix a documentation change into three code PRs.

## 5. Commands and results

Run in the isolated worktree only. No daemon, no port, no network.

```bash
npm test        # Test Files 22 passed | 1 skipped (23)
                # Tests      227 passed | 16 skipped (243)
npm run typecheck   # tsc --noEmit — clean
npm run lint       # eslint . --ext .ts — clean
npm run format     # prettier --check . — All matched files use Prettier code style!
npm run build      # clean && tsc && copy:assets
```

The 16 skipped tests are the `OPENFOX_E2E`-gated suite (`test/e2e/`).

## 6. Risks and preconditions

**Risks**

| Risk | Severity | Mitigation |
|---|---|---|
| The host contract is pinned to **2.0.161**; the devDependency is still `2.0.160` | Medium | The payload shapes were verified on **both**; the devDependency should be bumped to `2.0.161` in a follow-up (not done here — it would change the lockfile). |
| The plugin cannot create a session or launch a workflow on its own: `PluginContext` exposes no such API | **High (pre-existing)** | `src/host-client.ts` uses the host's documented HTTP API. The host's **port** and **network token** are not exposed to a plugin, so the base URL must be configured and the token supplied when the host's auth strategy is `network`. **This is the main precondition below.** |
| The control plane duplicates the host's task board functionally | Medium | Deliberate and documented in `COMPONENT_JUSTIFICATION.md`: the host's task board is not reachable from a plugin. Not a duplication of the *runner*. `UPSTREAM_PROPOSAL.md` proposes exposing it, which would let the plugin delete its own scheduler. |
| The user workflows `plan-issue-v3` / `build-verify-v3` / `publish-pr-v1` could not be read | Medium | Their content is **unverified** (access to `~/.config/openfox` was refused). The `issue_ref` parameter is required by `plan-issue-v3` per a code comment, not against the file itself. **Must be confirmed before enabling the plugin for real.** |
| The `dist/` conflicts were resolved by regeneration | Low | `npm run build` is now reproducible and the packaging test proves the artefact matches the source. |

**Preconditions before enabling anything for real**

1. The host base URL is configured and reachable; the token is supplied
   if the host's auth strategy is `network`.
2. The three workflow ids exist and expose the parameters the plugin
   sends — `issue_ref`, `issue_url`, `issue_number`, `issue_title`,
   `issue_body`, `issue_labels`, `issue_comments`, `repo_key`,
   `project_id`.
3. `dryRun` is turned **off** deliberately, after a dry-run pass.
4. `repos.mapping` maps each `owner/repo` to a real host project id.

**Not verified, and not verifiable without a live host**

- A real `POST /api/sessions` followed by a real `plan-issue-v3` launch.
- The real host's answer to a missing token under network auth (the 401
  is simulated, not observed).
- The end-to-end behaviour with a real CI/Mergify provider.

## 7. Suggested PR body (English)

> ## Summary
>
> This PR makes the plugin work with the OpenFox host as it actually
> behaves, and adds the deterministic control plane needed to run several
> issues concurrently.
>
> ### What was broken
>
> The plugin read the host's workflow events at the root of the payload,
> but the host nests them under `data`:
>
> ```
> { event, timestamp, sessionId, projectId?, data: { executionId, workflowId, status, … } }
> ```
>
> Consequences: `payload.status` and `payload.executionId` were
> `undefined`, so the chain never advanced; the host's status vocabulary
> is `running | waiting | completed | cancelled | blocked` and never
> `done`, so the engine's `done` branch was unreachable; and the PR URL
> lives in `data.result.output`, so no PR was ever captured.
>
> Two further defects were found: the chain advance was never persisted
> (the host stores plugin values as JSON, so the in-place mutation was
> lost and the chain stalled after the first workflow), and `npm run
> build` was a no-op when `dist/` existed, so the published artefact was
> stale and still carried the `Plan Issue v2` display names the host
> cannot resolve.
>
> An empty `ordering.dependencyPattern` also compiled to a regex that
> matches the empty string at every position and froze the host on every
> scan.
>
> ### What is added
>
> - A **durable control plane**: one registry under a single storage key,
>   with idempotent admission, deterministic priority, dependency gating,
>   exclusive reservation, leases, per-issue token budgets and metrics —
>   all pure functions, no LLM call.
> - A **supported host client**: OpenFox exposes no session or workflow
>   API to plugins, so the plugin uses the host's documented local HTTP
>   API and the host's own `/<workflow-id> <params>` launch syntax. It
>   fails closed, imports no host internals, and only accepts a loopback
>   base URL.
> - **Safe defaults**: `dryRun` is on and no scan starts on enable, so
>   enabling the plugin never creates a session, writes to GitHub or
>   launches a workflow.
> - **One scheduler**: the control plane and the legacy queue path were
>   both able to start the same issue, creating two sessions for one
>   issue. The control plane is now the only scheduler, and an expired
>   lease blocks the issue instead of risking a duplicate session.
>
> ### Testing
>
> 218 unit and contract tests, no network and no server: the host
> payloads are reproduced exactly, the host's routes and error codes are
> pinned against OpenFox 2.0.161, and the whole flow is exercised with
> a fake GitHub and a fake host.
>
> ### Known limitations
>
> - The plugin cannot create a session or launch a workflow without the
>   host's HTTP API: `PluginContext` exposes no such capability. The
>   base URL must be configured, and the token supplied when the host's
>   auth strategy is `network`.
> - The content of the `plan-issue-v3` / `build-verify-v3` /
>   `publish-pr-v1` workflows is unverified.
> - No real end-to-end run was performed: that requires starting a host
>   and opening a session.
>
> ### Safety
>
> This PR contains no secret, no auto-merge path and no GitHub write
> enabled by default.
