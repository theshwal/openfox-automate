/**
 * GitHub post-process — optional writes after a chain completes.
 *
 * All toggles (`post.closeOnSuccess`, `post.assignOnSuccess`,
 * `post.commentTemplate`) default to false/empty; Delivery v2 handles
 * the canonical interaction. The plugin only acts when explicitly
 * configured to.
 */

import type { PluginSettings, QueueEntry } from './types.js'
import {
  addIssueLabel,
  assignIssue,
  createIssueComment,
  removeIssueLabel,
  setIssueState,
  validateToken,
} from './github.js'

export interface PostProcessResult {
  commented: boolean
  labeled: { added: string[]; removed: string[] }
  closed: boolean
  assigned: string[]
  errors: string[]
}

export function renderTemplate(
  template: string,
  ctx: { title: string; summary: string; sessionUrl: string; prUrl: string },
): string {
  return template
    .replace(/\{\{title\}\}/g, ctx.title)
    .replace(/\{\{summary\}\}/g, ctx.summary)
    .replace(/\{\{sessionUrl\}\}/g, ctx.sessionUrl)
    .replace(/\{\{prUrl\}\}/g, ctx.prUrl)
}

export async function postProcess(
  entry: QueueEntry,
  settings: PluginSettings,
  ctx: { summary: string; sessionUrl: string; prUrl: string; me?: string },
  deps: { token: string; owner: string; repo: string },
): Promise<PostProcessResult> {
  const result: PostProcessResult = {
    commented: false,
    labeled: { added: [], removed: [] },
    closed: false,
    assigned: [],
    errors: [],
  }

  const template = settings['post.commentTemplate']
  if (template && template.trim().length > 0) {
    try {
      const body = renderTemplate(template, {
        title: entry.title,
        summary: ctx.summary,
        sessionUrl: ctx.sessionUrl,
        prUrl: ctx.prUrl,
      })
      const r = await createIssueComment(deps.token, deps.owner, deps.repo, entry.issueNumber, body)
      if (r.ok && r.data) result.commented = true
      else result.errors.push(`comment: ${r.error ?? r.status}`)
    } catch (e) {
      result.errors.push(`comment exception: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  try {
    const added = await addIssueLabel(deps.token, deps.owner, deps.repo, entry.issueNumber, 'agent-done')
    if (added.ok) result.labeled.added.push('agent-done')
    else result.errors.push(`label add: ${added.error ?? added.status}`)
  } catch (e) {
    result.errors.push(`label add exception: ${e instanceof Error ? e.message : String(e)}`)
  }
  try {
    const removed = await removeIssueLabel(
      deps.token,
      deps.owner,
      deps.repo,
      entry.issueNumber,
      'agent-ready',
    )
    if (removed.ok || removed.status === 404) result.labeled.removed.push('agent-ready')
    else result.errors.push(`label remove: ${removed.error ?? removed.status}`)
  } catch (e) {
    result.errors.push(`label remove exception: ${e instanceof Error ? e.message : String(e)}`)
  }

  if (settings['post.closeOnSuccess']) {
    try {
      const r = await setIssueState(deps.token, deps.owner, deps.repo, entry.issueNumber, 'closed')
      if (r.ok) result.closed = true
      else result.errors.push(`close: ${r.error ?? r.status}`)
    } catch (e) {
      result.errors.push(`close exception: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (settings['post.assignOnSuccess'] && ctx.me) {
    try {
      const r = await assignIssue(deps.token, deps.owner, deps.repo, entry.issueNumber, [ctx.me])
      if (r.ok) result.assigned.push(ctx.me)
      else result.errors.push(`assign: ${r.error ?? r.status}`)
    } catch (e) {
      result.errors.push(`assign exception: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return result
}

export async function fetchAuthenticatedLogin(token: string): Promise<string | null> {
  const res = await validateToken(token)
  if (!res.valid) return null
  const r = await fetch('https://api.github.com/user', {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'openfox-automate/0.1.0',
    },
  })
  if (!r.ok) return null
  const body = (await r.json()) as { login?: string }
  return body.login ?? null
}
