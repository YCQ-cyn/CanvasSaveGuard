import { installPanelShortcutBoundary } from './panel-shortcuts.mjs';

export function installPanelLayout(doc) {
  const shadow = doc.querySelector('#canvas-save-guard')?.shadowRoot;
  if (!shadow) return;
  installPanelShortcutBoundary(shadow.host, doc);
  const body = shadow.querySelector('.body');
  let information = shadow.querySelector('#panel-information');
  if (!information) {
    information = doc.createElement('div');
    information.id = 'panel-information';
    body.prepend(information);
  }
  for (const id of ['status', 'cleanup-progress', 'detail']) {
    const element = shadow.getElementById(id);
    if (element) information.append(element);
  }
  const style = shadow.querySelector('#fixed-panel-layout') || doc.createElement('style');
  style.id = 'fixed-panel-layout';
  style.textContent = `
    section { height: 333px; max-height: calc(100dvh - 36px); display: flex; flex-direction: column; overflow: hidden; }
    section.closed { height: auto; }
    header { flex: 0 0 auto; }
    .body { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
    #panel-information { flex: 1; min-height: 0; overflow-y: auto; padding-right: 2px; }
    #status { min-height: 18px; margin-top: 3px; font-size: 11px; }
    #deletion-grace { font-size: 11px; margin-top: 4px; color: light-dark(#775411,#dfc68b); line-height: 1.4; }
    #cleanup-progress:not([hidden]) { display: grid; grid-template-columns: 1fr auto; margin-top: 4px; padding-top: 4px; }
    #cleanup-progress-title { grid-column: 1; }
    #cleanup-progress-count { grid-column: 2; grid-row: 1; }
    #cleanup-progress-stage { grid-column: 1 / -1; min-height: 16px; margin-top: 2px; }
    #cleanup-progress progress { grid-column: 1 / -1; height: 6px; margin-top: 3px; }
    #cleanup-progress-result { height: 140px; max-height: 140px; overflow-y: auto; scrollbar-gutter: stable; }
    #cleanup-progress-result { grid-column: 1 / -1; margin-top: 3px; }
    #cleanup-progress-result[hidden] { display: none; }
    .buttons { flex: 0 0 auto; display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 4px; margin-top: 6px; padding-top: 0; }
    .buttons button { padding: 3px 4px; font-size: 11px; line-height: 1.4; white-space: nowrap; }
    #compat { flex: 0 0 auto; margin-top: 5px; font-size: 10px; }
    section:has(#cleanup-progress:not([hidden])) #compat { display: none; }
    #detail { max-height: 72px; overflow-y: auto; }
    #panel-information, #cleanup-progress-result, #detail { scrollbar-width: thin; scrollbar-color: #8888 transparent; overscroll-behavior: contain; }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-thumb { background: #8888; border-radius: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
  `;
  shadow.append(style);
  function placeRetryPanel() {
    const retry = doc.querySelector('#local-canvas-retry-panel');
    if (!retry) return;
    const bottom = Math.round(shadow.querySelector('section').getBoundingClientRect().height + 30);
    retry.style.bottom = `${bottom}px`;
    retry.style.setProperty('--guard-retry-bottom', `${bottom}px`);
  }
  if (!shadow.__guardPanelObserver) {
    shadow.__guardPanelObserver = new ResizeObserver(placeRetryPanel);
    shadow.__guardPanelObserver.observe(shadow.querySelector('section'));
  }
  placeRetryPanel();
}
