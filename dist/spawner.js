/**
 * Session spawner.
 *
 * Resolves OpenFox internals and uses the host `sessionManager` to create
 * sessions. The actual workflow chain driving is delegated to `chain.ts`.
 *
 * In production this relies on the dynamic import in `resolve-openfox.ts`.
 * In tests, the spawner takes an injected `createSession` function so unit
 * tests do not need a real OpenFox host.
 */
import { getOpenFoxInternals } from './resolve-openfox.js';
export function buildSessionTitle(entry) {
    return `[issue #${entry.issueNumber}] ${entry.title}`.slice(0, 200);
}
export async function spawnSessionFor(entry, deps = {}) {
    if (deps.createSession) {
        return deps.createSession(entry.projectId, buildSessionTitle(entry));
    }
    const internals = await getOpenFoxInternals();
    if (!internals) {
        throw new Error('OpenFox internals are not available. Either inject `createSession` for testing or ensure `openfox` is resolvable from the plugin loader.');
    }
    const sm = internals.sessionManager;
    const session = await sm.createSession(entry.projectId, buildSessionTitle(entry));
    return session;
}
export async function stopSession(sessionId, deps = {}) {
    if (deps.stopSession) {
        await deps.stopSession(sessionId);
        return;
    }
    const internals = await getOpenFoxInternals();
    if (!internals) {
        throw new Error('OpenFox internals are not available');
    }
    const sm = internals.sessionManager;
    if (sm.stopSession) {
        await sm.stopSession(sessionId);
    }
    else if (sm.setRunning) {
        sm.setRunning(sessionId, false);
    }
}
//# sourceMappingURL=spawner.js.map