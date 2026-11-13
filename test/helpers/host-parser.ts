/**
 * The REAL OpenFox 2.0.161 prompt parser.
 *
 * This is a faithful transcription of the host's own code, so the tests
 * can assert what the host ACTUALLY interprets — not what the plugin
 * believes it sends.
 *
 * Source: the installed host,
 * `/home/hermesy/.local/share/openfox/lib/node_modules/openfox/dist/chunk-Q54OOZ5U.js`
 * (the "src/server/tasks/slash.ts" section):
 *
 *   function parseSlashInvocation(prompt) {
 *     const trimmed = prompt.trim();
 *     if (!trimmed.startsWith("/")) return null;
 *     const parts = trimmed.slice(1).split(/\s+/);
 *     const id = parts[0];
 *     if (!id) return null;
 *     return { id, args: parts.slice(1) };
 *   }
 *
 *   function workflowParamsFromArgs(parameters, args) {
 *     const params = {};
 *     if (!parameters || parameters.length === 0) {
 *       args.forEach((value, index) => { params[String(index)] = value; });
 *       return params;
 *     }
 *     const sorted = [...parameters].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
 *     sorted.forEach((param, index) => {
 *       const value = args[index];
 *       if (value !== void 0) params[param.id] = value;
 *     });
 *     return params;
 *   }
 *
 *   async function resolveSlashLaunch(configDir, projectDir, prompt) {
 *     const invocation = parseSlashInvocation(prompt);
 *     if (!invocation) return null;
 *     const workflow = findWorkflowById(invocation.id, workflows);
 *     if (workflow) {
 *       const params = workflowParamsFromArgs(workflow.metadata.parameters, invocation.args);
 *       const required = (workflow.metadata.parameters ?? []).filter((p) => p.required).map((p) => p.id);
 *       const missingRequired = required.filter((id) => !(id in params));
 *       if (missingRequired.length > 0) return null;
 *       return { kind: "workflow", workflowId: workflow.metadata.id, params };
 *     }
 *     ...
 *   }
 *
 * THE TWO FACTS THAT MATTER:
 *
 *   1. `split(/\s+/)` splits on EVERY whitespace, NEWLINES INCLUDED.
 *      Free text appended to the prompt becomes positional arguments.
 *   2. The host launches the workflow with `{ workflowId, params, scope,
 *      attachments }` — the prompt TEXT is dropped (same file, the
 *      `seedSession` function). The prompt is a transport for the
 *      positional arguments, not a channel for content.
 */

/** A parameter as declared by a workflow. */
export interface HostParameter {
  id: string
  position?: number | undefined
  required?: boolean | undefined
}

/** A workflow as the host sees it. */
export interface HostWorkflow {
  id: string
  parameters?: HostParameter[] | undefined
}

export interface HostSlashInvocation {
  id: string
  args: string[]
}

/** `parseSlashInvocation` — the host's own implementation. */
export function parseSlashInvocation(prompt: string): HostSlashInvocation | null {
  const trimmed = prompt.trim()
  if (!trimmed.startsWith('/')) return null
  const parts = trimmed.slice(1).split(/\s+/)
  const id = parts[0]
  if (!id) return null
  return { id, args: parts.slice(1) }
}

/** `workflowParamsFromArgs` — the host's own implementation. */
export function workflowParamsFromArgs(
  parameters: HostParameter[] | undefined,
  args: string[],
): Record<string, string> {
  const params: Record<string, string> = {}
  if (!parameters || parameters.length === 0) {
    args.forEach((value, index) => {
      params[String(index)] = value
    })
    return params
  }
  const sorted = [...parameters].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
  sorted.forEach((param, index) => {
    const value = args[index]
    if (value !== undefined) params[param.id] = value
  })
  return params
}

/**
 * `resolveSlashLaunch` — the host's own implementation, for a workflow.
 *
 * Returns null when the launch would be REFUSED (a required parameter is
 * missing), which is the host's way of queueing the prompt as a plain
 * chat message instead of starting the workflow.
 */
export function resolveSlashLaunch(
  workflow: HostWorkflow,
  prompt: string,
): { kind: 'workflow'; workflowId: string; params: Record<string, string> } | null {
  const invocation = parseSlashInvocation(prompt)
  if (!invocation) return null
  if (invocation.id !== workflow.id) return null
  const params = workflowParamsFromArgs(workflow.parameters, invocation.args)
  const required = (workflow.parameters ?? []).filter((p) => p.required).map((p) => p.id)
  const missingRequired = required.filter((id) => !(id in params))
  if (missingRequired.length > 0) return null
  return { kind: 'workflow', workflowId: workflow.id, params }
}

/**
 * The parameters the REAL workflows of this machine declare, read from
 * the installed host's workflow definitions
 * (`~/.config/openfox/workflows/*.workflow.json`):
 *
 *   plan-issue-v3   → issue_ref (position 0, REQUIRED), repo (position 1)
 *   build-verify-v3 → workdir (position 0)
 *   publish-pr-v1   → workdir (position 0)
 */
export const REAL_WORKFLOWS: HostWorkflow[] = [
  {
    id: 'plan-issue-v3',
    parameters: [
      { id: 'issue_ref', position: 0, required: true },
      { id: 'repo', position: 1, required: false },
    ],
  },
  { id: 'build-verify-v3', parameters: [{ id: 'workdir', position: 0, required: false }] },
  { id: 'publish-pr-v1', parameters: [{ id: 'workdir', position: 0, required: false }] },
]

/** The workflow with that id, from {@link REAL_WORKFLOWS}. */
export function realWorkflow(id: string): HostWorkflow {
  const found = REAL_WORKFLOWS.find((w) => w.id === id)
  if (!found) throw new Error(`unknown workflow: ${id}`)
  return found
}
