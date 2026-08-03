/**
 * Lightweight guards for stale reads and duplicate mutations.
 * Kept framework-free so all dashboard modules can share it.
 */
(function attachSyncGuards(global) {
    const requestSequences = new Map();
    const mutationLocks = new Set();

    function nextRequest(resource) {
        const key = String(resource || 'default');
        const id = (requestSequences.get(key) || 0) + 1;
        requestSequences.set(key, id);
        return { key, id, isCurrent: () => requestSequences.get(key) === id };
    }

    function acquireMutation(resource) {
        const key = String(resource || 'default');
        if (mutationLocks.has(key)) return null;
        mutationLocks.add(key);
        let released = false;
        return {
            key,
            release() {
                if (released) return;
                released = true;
                mutationLocks.delete(key);
            }
        };
    }

    function isMutationLocked(resource) {
        return mutationLocks.has(String(resource || 'default'));
    }

    const guards = { nextRequest, acquireMutation, isMutationLocked };
    global.syncGuards = global.syncGuards || guards;
    if (typeof module !== 'undefined' && module.exports) module.exports = guards;
})(typeof window !== 'undefined' ? window : globalThis);
