// One lease covers preparation, the network request and image persistence.
// Distinct images remain independent, including siblings in the same group.
export function createRetryFlight(currentProjectId) {
  const active = new Set();
  const keyFor = (projectId, nodeId, imageId) => JSON.stringify([projectId || currentProjectId(), nodeId, imageId || null]);
  const begin = (projectId, nodeId, imageId) => {
    const key = keyFor(projectId, nodeId, imageId);
    if (active.has(key)) return false;
    active.add(key);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active.delete(key);
    };
  };
  begin.has = (projectId, nodeId, imageId) => active.has(keyFor(projectId, nodeId, imageId));
  return begin;
}
