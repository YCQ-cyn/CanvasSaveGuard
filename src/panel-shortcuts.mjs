// Native shortcuts see a shadow host instead of its focused input. Keep panel
// editing local, and release that focus when the user returns to the canvas.
export function installPanelShortcutBoundary(host, doc) {
  host.dataset.canvasShortcutsIgnore = '';
  if (host.dataset.guardShortcutBoundary) return;
  host.dataset.guardShortcutBoundary = '1';
  host.addEventListener('keydown', event => event.stopPropagation());
  const leavePanel = event => {
    if (doc.activeElement !== host || event.composedPath().includes(host)) return;
    host.shadowRoot?.activeElement?.blur();
    host.blur();
  };
  doc.addEventListener('pointerdown', leavePanel, true);
}
