/**
 * openfox-automate — plugin entry point.
 *
 * Wires together: settings, UI panel + header action, RPC handlers, hooks,
 * LLM tools, scan timer. Runtime state lives in `context.storage` under
 * "queue", "history", "scan_state", "executions".
 */
import type { PluginRegistry } from 'openfox/plugin';
export declare function register(registry: PluginRegistry): void;
export declare function deactivate(): void;
declare const _default: {
    register: typeof register;
    deactivate: typeof deactivate;
};
export default _default;
//# sourceMappingURL=index.d.ts.map