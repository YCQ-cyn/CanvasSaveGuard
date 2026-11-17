const STORAGE_KEY = 'canvas-save-guard:move-descendants';

export function installDescendantControl(guard, doc) {
  const win = doc.defaultView;
  if (!guard.descendantPreferenceVersion) {
    let enabled = false;
    try { enabled = win.localStorage.getItem(STORAGE_KEY) === '1'; } catch {}
    const paint = () => {
      const button = doc.querySelector('#canvas-save-guard')?.shadowRoot?.querySelector('#move-descendants');
      if (!button) return;
      button.textContent = `带动后代 · ${enabled ? '开' : '关'}`;
      button.setAttribute('aria-checked', String(enabled));
      button.style.background = enabled ? '#2563eb' : '';
      button.style.color = enabled ? '#fff' : '';
    };
    guard.descendantPreferenceVersion = 1;
    guard.getMoveDescendants = () => enabled;
    guard.setMoveDescendants = value => {
      enabled = !!value;
      try { win.localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0'); } catch {}
      paint();
    };
    guard.paintMoveDescendants = paint;
    win.addEventListener('storage', event => {
      if (event.key !== STORAGE_KEY && event.key !== null) return;
      enabled = event.key !== null && event.newValue === '1';
      paint();
    });
  }
  const shadow = doc.querySelector('#canvas-save-guard')?.shadowRoot;
  if (!shadow || shadow.querySelector('#move-descendants')) return;
  const button = doc.createElement('button');
  button.id = 'move-descendants'; button.type = 'button';
  button.setAttribute('role', 'switch'); button.setAttribute('aria-label', '移动时带动后代');
  button.title = '开启后，拖动节点会沿向外连线和图片组归属带动所有层级的后代，保持相对位置。多选或多条路径到达同一节点时只移动一次。';
  button.onclick = () => guard.setMoveDescendants(!guard.getMoveDescendants());
  shadow.querySelector('.buttons').append(button);
  guard.paintMoveDescendants();
}
