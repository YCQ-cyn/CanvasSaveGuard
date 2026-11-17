import { installPanelShortcutBoundary } from './panel-shortcuts.mjs';
import { installRetryRegion } from './retry-region.mjs';

// Shared by the installed canvas extension and the standalone userscript.
export const RETRY_PANEL_VERSION = "1.6.0";

export function installRetryPanel(document = globalThis.document) {
  const panelId = "local-canvas-retry-panel";
  const existing = document.getElementById(panelId);
  if (existing?.dataset.version === RETRY_PANEL_VERSION &&
      existing.shadowRoot?.getElementById("auto-start")) {
    installPanelShortcutBoundary(existing, document);
    return existing;
  }
  if (!document.body) {
    document.addEventListener("DOMContentLoaded", () => installRetryPanel(document), { once: true });
    return;
  }
  const previousInterval = existing?.shadowRoot?.getElementById("interval")?.value;
  const previousAutoInterval = existing?.shadowRoot?.getElementById("auto-interval")?.value;
  if (existing) {
    existing.shadowRoot?.getElementById("auto-cancel")?.click();
    existing.shadowRoot?.getElementById("stop")?.click();
    existing.dispatchEvent(new document.defaultView.Event("canvas-retry-upgrade"));
  }
  // Reuse the host so legacy refresh timers keep referring to the same panel.
  const panel = existing || document.createElement("aside");
  panel.id = panelId;
  // Events crossing a shadow root are retargeted to the host. Native canvas
  // shortcuts otherwise mistake input editing for Select All / Delete / Undo.
  installPanelShortcutBoundary(panel, document);
  panel.dataset.version = RETRY_PANEL_VERSION;
  Object.assign(panel.style, {
    position: "fixed", right: "16px", bottom: "84px", zIndex: "2147483647", pointerEvents: "none"
  });
  const root = panel.shadowRoot || panel.attachShadow({ mode: "open" });
  root.innerHTML = `
  <style>
    :host { color-scheme: dark; }
    section { pointer-events:auto;width:260px;height:302px;max-height:calc(100dvh - var(--guard-retry-bottom,84px) - 18px);display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box;padding:14px;border:1px solid #57534e;
      border-radius:14px;background:#242320;color:#fafaf9;box-shadow:0 6px 24px #0006;
      font:13px/1.6 system-ui,sans-serif; }
    strong { display:block;font-size:14px; }
    header { display:flex;flex:0 0 auto;align-items:center;justify-content:space-between;gap:12px; }
    #fold { padding:2px 6px;background:transparent;color:inherit; }
    section.closed { width:auto;height:auto;padding:0;border:0;background:transparent;box-shadow:none; }
    .closed header, .closed .body > :not(.manual-actions) { display:none; }
    .closed .body, .closed .manual-actions { margin:0; }
    #expand { display:none;background:#57534e;color:white; }
    .closed #expand { display:block; }
    .body { margin-top:8px;flex:1;min-height:0;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#78716c88 transparent;overscroll-behavior:contain; }
    ::-webkit-scrollbar { width:6px; }
    ::-webkit-scrollbar-thumb { background:#78716c88;border-radius:6px; }
    ::-webkit-scrollbar-track { background:transparent; }
    details { margin-top:6px;color:#d6d3d1;font-size:12px; }
    summary { cursor:pointer; }
    p { margin:6px 0 0;color:#d6d3d1;font-size:12px;line-height:1.4; }
    label { display:flex;gap:6px;align-items:center;margin-bottom:6px;font-size:12px; }
    input { width:66px;padding:3px 6px;border:1px solid #78716c;border-radius:5px;
      background:#1c1917;color:#fafaf9;font:inherit; }
    .actions { display:flex;gap:8px;margin-bottom:6px; }
    button { padding:6px 8px;border:0;border-radius:7px;cursor:pointer;font:inherit; }
      #start { flex:1;background:#2563eb;color:white; }
      #auto-start { flex:1;background:#57534e;color:white; }
      #auto-cancel { background:#57534e;color:white; }
    button:disabled { opacity:.45;cursor:default; }
    #status { min-height:20px;white-space:pre-line; }
    #auto-status { white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
    .scope { display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:3px; }
    #region-toggle { flex:0 0 auto;width:34px;height:20px;padding:2px;border-radius:12px;background:#57534e; }
    #region-toggle span { display:block;width:16px;height:16px;border-radius:50%;background:white;transition:transform .15s; }
    #region-toggle[aria-checked="true"] { background:#2563eb; }
    #region-toggle[aria-checked="true"] span { transform:translateX(14px); }
    #region-status { margin:0 0 8px;font-size:11px;overflow-wrap:anywhere; }
  </style>
  <section aria-label="批量重试工具">
      <header><strong>批量重试 ${RETRY_PANEL_VERSION}</strong><button id="fold" type="button" aria-label="收起批量重试工具">收起</button></header>
    <div class="body">
    <div class="scope"><span>区域重试</span><button id="region-toggle" type="button" role="switch" aria-label="区域重试" aria-checked="false"><span></span></button></div>
    <p id="region-status" role="status"></p>
    <label>逐项提交间隔（秒）<input id="interval" type="number" required min="0.2" max="60"
      step="0.1" value="1" aria-label="逐项提交间隔（秒）"></label>
    <div class="actions manual-actions">
      <button id="start" type="button">重试当前失败项</button>
      <button id="expand" type="button" aria-label="展开批量重试设置">展开</button>
    </div>
    <label>自动间隔（秒）<input id="auto-interval" type="number" required min="60"
      step="1" value="60" aria-label="自动重试间隔（秒）"></label>
    <div class="actions">
        <button id="auto-start" type="button" aria-pressed="false">自动重试</button>
      <button id="auto-cancel" type="button" disabled>取消重试</button>
    </div>
    <p id="auto-status" role="status" aria-live="polite">自动重试待开启</p>
    <p id="status" role="status" aria-live="polite">就绪</p>
    <details><summary>使用说明</summary>
    <p>自动按周期提交当前失败项，逐项使用上方提交间隔。从每轮第一项提交时计时。</p>
    <p>处理独立失败项和已展开图片组中的失败项，收起组自动跳过，每项每轮提交一次。重试使用网站现有配置，可能消耗额度。</p>
    <p>手动按设定间隔提交当前失败项一轮，生成结果请查看画布。</p>
    <p>开启区域重试后，Shift＋左键框选固定画布区域。手动与自动重试都使用该区域，区域内后来出现的失败项也会参与。重新框选可替换范围，收起的图片组跳过。</p>
    </details>
    </div>
  </section>`;
  document.body.append(panel);
  const regionControl = installRetryRegion(document);
  const foldButton = root.getElementById("fold");
  foldButton.addEventListener("click", () => {
    const closed = root.querySelector("section").classList.toggle("closed");
    foldButton.textContent = closed ? "展开" : "收起";
    foldButton.setAttribute("aria-label", closed ? "展开批量重试工具" : "收起批量重试工具");
    refreshCount();
    startButton.title = closed ? "点击重试，右键展开设置" : "";
  });
  const startButton = root.getElementById("start");
  root.getElementById("expand").addEventListener("click", () => foldButton.click());
  const intervalInput = root.getElementById("interval");
  const status = root.getElementById("status");
  const autoStartButton = root.getElementById("auto-start");
  const autoCancelButton = root.getElementById("auto-cancel");
  const autoIntervalInput = root.getElementById("auto-interval");
  const autoStatus = root.getElementById("auto-status");
  const regionToggle = root.getElementById("region-toggle");
  const regionStatus = root.getElementById("region-status");
  let manualController = null;
  let autoSession = null;
  const attempts = new Map();
  const settingsKey = "canvas-retry-settings-v1";
  try {
    const settings = JSON.parse(localStorage.getItem(settingsKey) || "{}");
    intervalInput.value = previousInterval || settings.manualInterval || "1";
    autoIntervalInput.value = previousAutoInterval || settings.autoInterval || "60";
    if (!intervalInput.checkValidity()) intervalInput.value = "1";
    if (!autoIntervalInput.checkValidity()) autoIntervalInput.value = "60";
  } catch {}
  function saveSettings() {
    if (!intervalInput.checkValidity() || !autoIntervalInput.checkValidity()) return;
    try {
      localStorage.setItem(settingsKey, JSON.stringify({
        manualInterval: intervalInput.value, autoInterval: autoIntervalInput.value
      }));
    } catch {}
  }
  intervalInput.addEventListener("change", saveSettings);
  autoIntervalInput.addEventListener("change", saveSettings);
  function updateControls() {
    startButton.disabled = Boolean(manualController);
    autoStartButton.setAttribute("aria-pressed", String(Boolean(autoSession)));
    autoStartButton.style.backgroundColor = autoSession ? "#2563eb" : "#57534e";
    intervalInput.disabled = Boolean(manualController);
    autoIntervalInput.disabled = Boolean(autoSession);
    autoCancelButton.disabled = !autoSession;
  }
  function cancelAutoRetry(message = "自动重试已取消。") {
    if (autoSession) {
      clearTimeout(autoSession.timer);
      autoSession.cancelMessage = message;
      autoSession.controller?.abort();
    }
    autoSession = null;
    autoStatus.textContent = message;
    updateControls();
  }
  function updateAutoStatus() {
    if (autoSession?.nextAt && !autoSession.controller) {
      const time = new Date(autoSession.nextAt).toLocaleTimeString("zh-CN", { hour12: false });
      autoStatus.textContent = `下次检查时间 ${time}`;
    }
  }
  async function runAutoRetry(session) {
    if (autoSession !== session) return;
    if (location.href !== session.url || !isCanvas()) {
      cancelAutoRetry("已切换画布，自动重试已取消。");
      return;
    }
    session.nextAt = 0;
    session.startedAt = null;
    autoStatus.textContent = "自动重试正在检查并提交失败项…";
    await run(session);
    if (autoSession !== session) return;
    if (location.href !== session.url) {
      cancelAutoRetry("已切换画布，自动重试已取消。");
      return;
    }
    session.nextAt = (session.startedAt ?? Date.now()) + session.delay;
    // Long user-selected delays are split to stay within the browser timer range.
    const waitUntilNextRound = () => {
      if (autoSession !== session) return;
      const remaining = session.nextAt - Date.now();
      if (remaining <= 0) {
        void runAutoRetry(session);
        return;
      }
      session.timer = setTimeout(waitUntilNextRound, Math.min(remaining, 2147483647));
    };
    waitUntilNextRound();
    updateAutoStatus();
  }
  function startAutoRetry() {
    if (autoSession) return;
    if (!isCanvas()) {
      autoStatus.textContent = "请先打开一个画布。";
      return;
    }
    if (!autoIntervalInput.reportValidity() || !intervalInput.reportValidity()) return;
    const seconds = Number(autoIntervalInput.value);
    if (!Number.isSafeInteger(seconds) || seconds < 60 || !Number.isSafeInteger(Date.now() + seconds * 1000)) {
      autoStatus.textContent = "请输入有效的整数秒数，最少60秒。";
      return;
    }
    autoSession = {
      url: location.href, delay: seconds * 1000, timer: null, nextAt: 0,
      startedAt: null, controller: null
    };
    updateControls();
    void runAutoRetry(autoSession);
  }
  function isCanvas() {
    return /^\/canvas\/[^/]+\/?$/.test(location.pathname);
  }
  function isInCollapsedGroup(button) {
    let node = button.closest("[data-node-id]");
    while (node) {
      if (node.getAttribute("data-batch-collapsed") === "true") return true;
      const toggles = node.querySelectorAll('button[aria-label="图片组已收起"]');
      if (Array.from(toggles).some((toggle) => toggle.closest("[data-node-id]") === node)) {
        return true;
      }
      node = node.parentElement?.closest("[data-node-id]");
    }
    return false;
  }
  function isRetry(button) {
    return button.textContent.trim() === "重试" && !button.disabled &&
      button.getAttribute("aria-disabled") !== "true" &&
      !button.closest('[hidden], [aria-hidden="true"]') && !isInCollapsedGroup(button) &&
      button.getClientRects().length > 0;
  }
  function retryButtons() {
    return Array.from(document.querySelectorAll("[data-node-id] button")).filter(isRetry);
  }
  function currentRetryBridge() {
    const bridge = globalThis.CanvasSaveGuardRetry;
    const projectId = decodeURIComponent(location.pathname.split("/")[2] || "");
    return bridge?.projectId === projectId && typeof bridge.list === "function" &&
      typeof bridge.retry === "function" ? bridge : null;
  }
  function retryTargets() {
    const scope = regionControl.snapshot();
    const bridge = currentRetryBridge();
    if (scope.enabled && (!scope.available || !scope.rectangle || scope.drawing)) return [];
    if (bridge) return bridge.list(scope.enabled ? scope.rectangle : undefined).map(nodeId => ({ nodeId, bridge }));
    return retryButtons().map(button => ({
      nodeId: button.closest("[data-node-id]").getAttribute("data-node-id"), button
    }));
  }
  function pause(milliseconds, signal) {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(finish, milliseconds);
      function finish() {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      }
      signal.addEventListener("abort", finish, { once: true });
    });
  }
  function stillOnCanvas(url, controller) {
    if (location.href !== url) {
      controller.abort();
      if (autoSession?.url === url) cancelAutoRetry("已切换画布，自动重试已取消。");
    }
    return !controller.signal.aborted;
  }
  function takeSnapshot() {
    const scope = regionControl.snapshot();
    const targets = retryTargets();
    const counts = new Map();
    for (const { nodeId } of targets) {
      counts.set(nodeId, (counts.get(nodeId) || 0) + 1);
    }
    return targets.map(target => {
      return { ...target, scope, exclusive: counts.get(target.nodeId) === 1, attempt: attempts.get(target.nodeId) || 0 };
    });
  }
  function resolveButton(item) {
    if (item.button.isConnected && isRetry(item.button) && item.button.closest("[data-node-id]")?.getAttribute("data-node-id") === item.nodeId) {
      return item.button;
    }
    if (!item.exclusive) return null;
    const matches = retryButtons().filter((button) => button.closest("[data-node-id]").getAttribute("data-node-id") === item.nodeId);
    return matches.length === 1 ? matches[0] : null;
  }
  function submitRetry(item) {
    const scope = regionControl.snapshot();
    if (scope.projectId !== item.scope.projectId || scope.revision !== item.scope.revision) return false;
    if (scope.enabled && (!scope.available || !scope.rectangle || scope.drawing)) return false;
    if (item.bridge) {
      const bridge = currentRetryBridge();
      return bridge ? bridge.retry(item.nodeId, scope.enabled ? scope.rectangle : undefined) : false;
    }
    const button = resolveButton(item);
    if (!button) return false;
    button.click();
    return true;
  }
  async function run(session = null) {
    if (session ? session.controller : manualController) return;
    const runStatus = session ? autoStatus : status;
    function setRunStatus(message) {
      if (!session || autoSession === session) runStatus.textContent = message;
    }
    if (!isCanvas()) {
      setRunStatus("请先打开一个画布。");
      return;
    }
    if (!intervalInput.reportValidity()) {
      setRunStatus("请填写有效的逐项提交间隔，范围为0.2至60秒。");
      return;
    }
    saveSettings();
    const interval = Number(intervalInput.value) * 1e3;
    if (!Number.isFinite(interval) || interval < 200 || interval > 6e4) return;
    const url = location.href;
    const controller = new AbortController();
    if (session) session.controller = controller;
    else manualController = controller;
    const { signal } = controller;
    updateControls();
    let submitted = 0;
    let skipped = 0;
    let total = 0;
    let lastSubmission = null;
    const navigationCheck = setInterval(() => stillOnCanvas(url, controller), 200);
    try {
      if (!stillOnCanvas(url, controller)) return;
      setRunStatus("正在检查当前失败项…");
      const items = takeSnapshot();
      total = items.length;
      if (!total) {
        const scope = regionControl.snapshot();
        setRunStatus(scope.enabled && (!scope.available || !scope.rectangle || scope.drawing)
          ? "请结束框选并固定重试区域。区域重试需要新版画布助手接口。"
          : `${scope.enabled ? '当前区域' : '当前画布'}没有可重试的失败项，收起的图片组已跳过。`);
        return;
      }
      for (const item of items) {
        if (!stillOnCanvas(url, controller)) break;
        if (lastSubmission !== null) {
          let remaining = interval - (performance.now() - lastSubmission);
          while (remaining > 0 && stillOnCanvas(url, controller)) {
            setRunStatus(`已提交 ${submitted} / ${total} 项，按 ${interval / 1000} 秒间隔等待下一项。`);
            await pause(Math.min(remaining, 1000), signal);
            remaining = interval - (performance.now() - lastSubmission);
          }
        }
        if (!stillOnCanvas(url, controller)) break;
        const submittedAt = Date.now();
        const submittedMonotonic = performance.now();
        if ((attempts.get(item.nodeId) || 0) === item.attempt && submitRetry(item)) {
          if (session && session.startedAt === null) {
            session.startedAt = submittedAt;
            session.nextAt = session.startedAt + session.delay;
          }
          attempts.set(item.nodeId, item.attempt + 1);
          lastSubmission = submittedMonotonic;
          submitted += 1;
        } else {
          skipped += 1;
        }
        setRunStatus(`已提交 ${submitted} / ${total} 项，跳过 ${skipped} 项。`);
        await pause(0, signal);
      }
      const result = controller.scopeChanged ? "重试范围已更新，本轮已停止" : signal.aborted ? "已停止" : "本轮提交结束";
      setRunStatus(`${result}。已提交 ${submitted} / ${total} 项，跳过 ${skipped} 项。\n生成结果请查看画布。`);
    } catch (error) {
      console.error("[Canvas Retry]", error);
      setRunStatus(`操作中断。已提交 ${submitted} 项。\n${error.message}`);
    } finally {
      clearInterval(navigationCheck);
      if (session) {
        session.controller = null;
        if (session.cancelMessage && !autoSession) runStatus.textContent = session.cancelMessage;
      } else {
        manualController = null;
        if (signal.aborted) status.textContent = `${controller.scopeChanged ? '重试范围已更新，本轮已停止' : '已停止'}。已提交 ${submitted} / ${total} 项。`;
      }
      updateControls();
      refreshCount();
    }
  }
  function refreshCount() {
    if (autoSession && location.href !== autoSession.url) {
      cancelAutoRetry("已切换画布，自动重试已取消。");
    }
    updateAutoStatus();
    const scope = regionControl.snapshot();
    regionToggle.disabled = !scope.available && !scope.enabled;
    regionToggle.setAttribute('aria-checked', String(scope.enabled));
    regionToggle.title = scope.available ? '开启后使用固定框选区域，关闭后恢复全画布重试' : '请重新加载画布助手扩展并刷新画布，启用区域接口';
    regionStatus.textContent = scope.enabled
      ? !scope.available ? '等待新版画布接口，请保存后刷新画布'
        : scope.drawing ? '正在框选区域…'
          : scope.rectangle ? `区域已固定 · ${Math.round(scope.rectangle.right - scope.rectangle.left)} × ${Math.round(scope.rectangle.bottom - scope.rectangle.top)} · Shift＋左键重新框选`
            : 'Shift＋左键框选重试区域'
      : '全画布重试';
    autoStartButton.textContent = scope.enabled ? '区域自动重试' : '自动重试';
    regionControl.paint();
    panel.hidden = !isCanvas();
    if (!panel.isConnected && document.body) document.body.append(panel);
    const guard = document.getElementById("canvas-save-guard");
    panel.style.bottom = guard && getComputedStyle(guard).display !== "none" ? Math.max(18, window.innerHeight - guard.getBoundingClientRect().top + 10) + "px" : "18px";
    if (root.querySelector("section").classList.contains("closed")) {
      startButton.textContent = scope.enabled ? "区域重试" : "重试";
    } else if (!manualController) {
      startButton.textContent = `${scope.enabled ? '重试区域失败项' : '重试当前失败项'}（${retryTargets().length}）`;
    }
  }
  startButton.addEventListener("click", () => run());
  startButton.addEventListener("contextmenu", event => {
    if (!root.querySelector("section").classList.contains("closed")) return;
    event.preventDefault();
    foldButton.click();
  });
  autoStartButton.addEventListener("click", startAutoRetry);
  autoCancelButton.addEventListener("click", () => cancelAutoRetry());
  regionToggle.addEventListener('click', () => regionControl.setEnabled(!regionControl.snapshot().enabled));
  const unsubscribeRegion = regionControl.subscribe(({ scopeChanged }) => {
    if (scopeChanged) {
      for (const controller of [manualController, autoSession?.controller]) {
        if (!controller) continue;
        controller.scopeChanged = true;
        controller.abort();
      }
    }
    refreshCount();
  });
  function dispose() {
    manualController?.abort();
    cancelAutoRetry();
    clearInterval(refreshTimer);
    unsubscribeRegion();
    window.removeEventListener("pagehide", dispose);
    panel.removeEventListener("canvas-retry-upgrade", dispose);
  }
  refreshCount();
  updateControls();
  const refreshTimer = setInterval(refreshCount, 1500);
  window.addEventListener("pagehide", dispose, { once: true });
  panel.addEventListener("canvas-retry-upgrade", dispose, { once: true });
  return panel;
}
