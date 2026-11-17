export const POINTER_PATCH_VERSION = '1.0.1';

// Ant Design message cards can remain across most of the viewport during queued
// enter/leave animations. Keep their text visible without intercepting the canvas.
// Explicit controls (including a toast's close button) remain interactive.
export function installPointerPassthrough(doc) {
  const id='canvas-save-guard-pointer-style';
  const style=doc.getElementById(id)||doc.createElement('style');
  style.id=id;
  style.dataset.version=POINTER_PATCH_VERSION;
  style.textContent=`
    .ant-message, .ant-message * { pointer-events: none !important; }
    .ant-message :is(button, a, input, select, textarea, [role="button"], .ant-message-notice-close, .ant-message-close),
    .ant-message :is(button, a, input, select, textarea, [role="button"], .ant-message-notice-close, .ant-message-close) * {
      pointer-events: auto !important;
    }
  `;
  if(!style.isConnected){
    const target=doc.head||doc.documentElement;
    if(target)target.append(style);
    else doc.addEventListener('DOMContentLoaded',()=>installPointerPassthrough(doc),{once:true});
  }
  return style;
}
