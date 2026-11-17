const STORAGE_KEY = 'canvas-save-guard:grid-snap';

export function installGridSnapControl(guard, doc) {
  const win = doc.defaultView;
  if (!guard.gridPreferenceVersion) {
    let enabled = false;
    try { enabled = win.localStorage.getItem(STORAGE_KEY) === '1'; } catch {}
    const paint = () => {
      const button = doc.querySelector('#canvas-save-guard')?.shadowRoot?.querySelector('#grid-snap');
      if (!button) return;
      button.textContent = `网格吸附 · ${enabled ? '开' : '关'}`;
      button.setAttribute('aria-checked', String(enabled));
      button.style.background = enabled ? '#2563eb' : '';
      button.style.color = enabled ? '#fff' : '';
    };
    guard.gridPreferenceVersion = 1;
    guard.getGridSnap = () => enabled;
    guard.setGridSnap = value => {
      enabled = !!value;
      try { win.localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0'); } catch {}
      paint();
    };
    guard.paintGridSnap = paint;
    win.addEventListener('storage', event => {
      if (event.key !== STORAGE_KEY && event.key !== null) return;
      enabled = event.key === null ? false : event.newValue === '1';
      paint();
    });
  }
  const shadow = doc.querySelector('#canvas-save-guard')?.shadowRoot;
  if (!shadow || shadow.querySelector('#grid-snap')) return;
  const button = doc.createElement('button');
  button.id = 'grid-snap'; button.type = 'button';
  button.setAttribute('role', 'switch'); button.setAttribute('aria-label', '网格吸附');
  button.title = '全局半格吸附，步长为 24 画布单位，与整理间距一致。适用于所有画布的节点和子图拖动，按住 Alt 可临时自由移动。';
  button.onclick = () => guard.setGridSnap(!guard.getGridSnap());
  shadow.querySelector('.buttons').append(button);
  guard.paintGridSnap();
}
