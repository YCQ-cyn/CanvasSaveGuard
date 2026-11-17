(() => {
  const previous = globalThis.__canvasGuardCleanupBridge;
  if (previous) {
    window.removeEventListener('message', previous.listener, true);
    previous.observer?.disconnect();
  }
  const token = crypto.randomUUID();
  const marker = 'data-canvas-guard-bridge';
  const runtime = chrome.runtime;
  let observer;
  function markActive() {
    if (!document.documentElement) return false;
    document.documentElement.setAttribute(marker, token);
    observer?.disconnect();
    return true;
  }
  if (!markActive()) {
    observer = new MutationObserver(markActive);
    observer.observe(document, { childList: true });
  }
  const listener = async event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.type !== 'canvas-guard-cleanup-v2') return;
    if (document.documentElement?.getAttribute(marker) !== token) return;
    const { id, action, data } = event.data;
    if (!['prepare', 'validateReferences', 'releaseMedia', 'finish'].includes(action)) return;
    // Only the latest bridge handles versioned requests. Result messages keep
    // the page's existing response contract.
    event.stopImmediatePropagation();
    try {
      const response = await runtime.sendMessage({ type: 'canvas-guard-cleanup', action, data });
      window.postMessage({ type: 'canvas-guard-cleanup-result', id, ...response }, location.origin);
    } catch (error) {
      window.postMessage({ type: 'canvas-guard-cleanup-result', id, error: error.message }, location.origin);
    }
  };
  globalThis.__canvasGuardCleanupBridge = { token, listener, observer };
  window.addEventListener('message', listener, true);
})();
