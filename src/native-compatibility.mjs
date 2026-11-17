export const BATCH_VISUAL_VERSION = 21;

// The panel can be attached to a running page before its native application
// bundle is reloaded. Report that distinction without replacing live state.
export function installNativeCompatibility(guard, doc, expectedVersion) {
  if (doc.location.hostname !== 'canvas.best') return;
  const shadow = doc.querySelector('#canvas-save-guard')?.shadowRoot;
  if (!shadow) return;
  let notice = shadow.getElementById('native-compatibility');
  if (!notice) {
    notice = doc.createElement('div');
    notice.id = 'native-compatibility';
    notice.setAttribute('role', 'status');
    notice.style.cssText = 'font-size:11px;color:#c56827;line-height:1.5;margin-top:4px;overflow-wrap:anywhere';
    (shadow.getElementById('panel-information') || shadow.querySelector('.body')).prepend(notice);
  }
  const site = doc.defaultView.CanvasSaveGuardNative;
  const outdated = guard.version !== expectedVersion || site && site.batchVisualVersion !== BATCH_VISUAL_VERSION;
  notice.hidden = !outdated;
  notice.textContent = outdated ? `当前页面仍使用旧版插件接口。请保存当前画布，重新加载扩展后刷新画布，启用 ${expectedVersion} 的最新保护及缓存核对。` : '';
  notice.dataset.writerVersion = guard.version || '';
  notice.dataset.nativeVersion = site?.patchVersion || '';
  notice.dataset.batchVisualVersion = String(site?.batchVisualVersion || 0);
  const heading = shadow.querySelector('strong');
  if (heading) heading.textContent = `画布助手 · ${guard.version || expectedVersion}`;
}
