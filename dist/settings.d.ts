import type { PluginSettingsSchema } from 'openfox/plugin';
/**
 * Settings schema for openfox-automate.
 *
 * Each field is rendered automatically in the Plugins tab form. Secrets
 * (password type with secret:true) are masked on read and preserved on
 * empty submit. See docs/PLUGINS.md § Settings for the full contract.
 */
export declare const settingsSchema: PluginSettingsSchema;
import type { PluginSettings } from './types.js';
export declare function readSettings(raw: Record<string, unknown>): PluginSettings;
export declare function parseRepoMapping(text: string | undefined): {
    repoKey: string;
    projectId: string;
}[];
export declare function parseChain(text: string | undefined): string[];
export declare function parseRepoOverrides(text: string | undefined): Map<string, string[]>;
export declare function parseIgnoreLabels(text: string | undefined): string[];
//# sourceMappingURL=settings.d.ts.map