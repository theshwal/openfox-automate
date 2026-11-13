/**
 * Mapping the plugin's values onto the parameters a workflow DECLARES.
 *
 * WHY THIS MODULE EXISTS
 *
 * The host resolves a `/<workflow-id> <args…>` prompt like this (OpenFox
 * 2.0.161, dist/chunk-Q54OOZ5U.js):
 *
 *   parseSlashInvocation(prompt)
 *     → trimmed.slice(1).split(/\s+/)          // SPLITS ON EVERY SPACE
 *     → { id: parts[0], args: parts.slice(1) }
 *
 *   workflowParamsFromArgs(parameters, args)
 *     → sorted by declared `position`
 *     → params[param.id] = args[index]          // BY POSITION
 *
 *   resolveSlashLaunch(...)
 *     → REFUSES the launch when a required parameter is missing
 *
 * Two consequences drive this module:
 *
 *   1. THE PROMPT IS NEVER TRANSMITTED. The host launches the workflow
 *      with `{ workflowId, params, scope, attachments }` — the prompt text
 *      itself is dropped (chunk-Q54OOZ5U.js:1240-1245). So the issue
 *      context cannot travel in the prompt: appending it there would not
 *      only fail to deliver it, it would CORRUPT the mapping, because the
 *      free text is split on whitespace and its first token becomes the
 *      NEXT positional argument.
 *
 *   2. THE ORDER IS THE WORKFLOW'S, NOT THE PLUGIN'S. The arguments are
 *      mapped by position onto the parameters sorted by their declared
 *      `position`. `Object.keys()` of a parameter bag is NOT that order,
 *      and a parameter the plugin cannot fill must NOT be skipped: the
 *      positional mapping would shift and every following parameter would
 *      receive the wrong value.
 *
 * The contract of the workflows the plugin drives (read from the installed
 * host's workflow definitions):
 *
 *   plan-issue-v3   → issue_ref (position 0, REQUIRED), repo (position 1)
 *   build-verify-v3 → workdir (position 0)
 *   publish-pr-v1   → workdir (position 0)
 *
 * The planner re-reads the issue itself with an authenticated
 * `gh issue view`, so the issue body and comments never need to travel:
 * only the TARGET does.
 */
/**
 * Map the plugin's values onto the parameters a workflow declares.
 *
 * FAIL CLOSED by design:
 *
 *   - when the declared parameters could not be discovered, the launch is
 *     REFUSED: guessing the order from `Object.keys()` is what produced
 *     the `repo` parameter holding an issue URL;
 *   - when a REQUIRED parameter has no value, the launch is REFUSED: the
 *     host would queue the prompt as a plain chat message and the workflow
 *     would never start, silently.
 *
 * A parameter the plugin has no value for is simply NOT sent: the host
 * maps `args[index]` and ignores the ones beyond the array, so the
 * positional mapping of the following parameters is unaffected.
 */
export function mapDeclaredParameters(declared, available) {
    if (!declared) {
        return {
            ok: false,
            reason: 'discovery-failed',
            message: 'the parameters declared by the workflow could not be read from the host; ' +
                'the launch is refused rather than guessed',
        };
    }
    // The host sorts by the declared position. The same order is used here,
    // so the values line up with what the host will read.
    const sorted = [...declared].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const params = {};
    const values = [];
    const missing = [];
    for (const [index, parameter] of sorted.entries()) {
        const value = available[parameter.id];
        if (typeof value === 'string' && value.length > 0) {
            params[parameter.id] = value;
            values.push(value);
            continue;
        }
        // The parameter has no value.
        //
        // The host maps `args[index]` onto `sorted[index]`, so the values are
        // positional: a value that is NOT sent leaves its slot EMPTY, and the
        // NEXT parameter would slide into it. A gap therefore corrupts every
        // parameter after it — which is exactly how `repo` ended up holding
        // an issue URL.
        //
        // So a gap is only acceptable as the LAST declared position: the
        // trailing parameter then simply stays unset, which the host maps to
        // undefined and the workflow treats as "use the default".
        if (parameter.required || index < sorted.length - 1) {
            missing.push(parameter.id);
        }
    }
    if (missing.length > 0) {
        return {
            ok: false,
            reason: 'missing-required',
            message: `the workflow needs parameter(s) ${missing.join(', ')}, which the plugin cannot provide`,
            missing,
        };
    }
    return { ok: true, values, params };
}
//# sourceMappingURL=parameter-mapping.js.map