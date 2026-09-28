/**
 * GitHub post-process — optional writes after a chain completes.
 *
 * All toggles (`post.closeOnSuccess`, `post.assignOnSuccess`,
 * `post.commentTemplate`) default to false/empty; Delivery v2 handles
 * the canonical interaction. The plugin only acts when explicitly
 * configured to.
 */
import type { PluginSettings, QueueEntry } from './types.js';
export interface PostProcessResult {
    commented: boolean;
    labeled: {
        added: string[];
        removed: string[];
    };
    closed: boolean;
    assigned: string[];
    errors: string[];
}
export declare function renderTemplate(template: string, ctx: {
    title: string;
    summary: string;
    sessionUrl: string;
    prUrl: string;
}): string;
export declare function postProcess(entry: QueueEntry, settings: PluginSettings, ctx: {
    summary: string;
    sessionUrl: string;
    prUrl: string;
    me?: string;
}, deps: {
    token: string;
    owner: string;
    repo: string;
    signal?: AbortSignal;
}): Promise<PostProcessResult>;
export declare function fetchAuthenticatedLogin(token: string, signal?: AbortSignal): Promise<string | null>;
//# sourceMappingURL=postprocess.d.ts.map