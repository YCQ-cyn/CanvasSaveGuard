// ==UserScript==
// @name         无限画布 · 一键重试全部失败项
// @namespace    local.canvas-retry
// @version      1.6.0
// @description  独立控制手动和自动重试，自动间隔按秒设置且至少60秒，跳过收起的图片组。
// @match        https://canvas.modelaryx.com/*
// @match        https://canvas.best/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
(() => {
  // src/panel-shortcuts.mjs
  function installPanelShortcutBoundary(host, doc) {
    host.dataset.canvasShortcutsIgnore = "";
    if (host.dataset.guardShortcutBoundary) return;
    host.dataset.guardShortcutBoundary = "1";
    host.addEventListener("keydown", (event) => event.stopPropagation());
    const leavePanel = (event) => {
      if (doc.activeElement !== host || event.composedPath().includes(host)) return;
      host.shadowRoot?.activeElement?.blur();
      host.blur();
    };
    doc.addEventListener("pointerdown", leavePanel, true);
  }

  // src/retry-region.mjs
  function normalizeRetryRectangle(rectangle) {
    if (!rectangle) return null;
    const left = Math.min(rectangle.startWorldX, rectangle.currentWorldX);
    const right = Math.max(rectangle.startWorldX, rectangle.currentWorldX);
    const top = Math.min(rectangle.startWorldY, rectangle.currentWorldY);
    const bottom = Math.max(rectangle.startWorldY, rectangle.currentWorldY);
    return [left, right, top, bottom].every(Number.isFinite) && right > left && bottom > top ? { left, right, top, bottom } : null;
  }
  function installRetryRegion(doc) {
    const win = doc.defaultView;
    if (win.CanvasSaveGuardRetryRegion?.version === 1) return win.CanvasSaveGuardRetryRegion;
    const listeners = /* @__PURE__ */ new Set();
    let projectId = null, enabled = false, rectangle = null, candidate = null, drawing = false, revision = 0;
    let overlay = null, frame = null;
    const storageKey = (id) => `canvas-retry-region-v1:${id}`;
    const currentId = () => /^\/canvas\/[^/]+\/?$/.test(win.location.pathname) ? decodeURIComponent(win.location.pathname.split("/")[2]) : "";
    function publish(scopeChanged) {
      if (scopeChanged) revision++;
      for (const listener of listeners) listener({ scopeChanged });
      paint();
    }
    function syncProject() {
      const id = currentId();
      if (id === projectId) return;
      projectId = id;
      enabled = false;
      rectangle = null;
      candidate = null;
      drawing = false;
      try {
        const saved = JSON.parse(win.localStorage.getItem(storageKey(id)) || "{}");
        enabled = saved.enabled === true;
        rectangle = normalizeRetryRectangle(saved.rectangle && {
          startWorldX: saved.rectangle.left,
          currentWorldX: saved.rectangle.right,
          startWorldY: saved.rectangle.top,
          currentWorldY: saved.rectangle.bottom
        });
      } catch {
      }
      publish(true);
    }
    function persist() {
      if (!projectId) return;
      try {
        win.localStorage.setItem(storageKey(projectId), JSON.stringify({ enabled, rectangle }));
      } catch {
      }
    }
    function bridge() {
      const value = win.CanvasSaveGuardRetry;
      return value?.projectId === projectId && value.regionVersion === 1 ? value : null;
    }
    function snapshot() {
      syncProject();
      return { projectId, enabled, rectangle: rectangle && { ...rectangle }, drawing, revision, available: !!bridge() };
    }
    function paint(viewport) {
      if (!doc.body) return;
      const native = bridge();
      if (!enabled || drawing || !rectangle || !native) {
        if (overlay) overlay.hidden = true;
        return;
      }
      const canvas = native.getCanvasRect?.();
      const view = viewport || native.getViewport?.();
      if (!canvas || !view || ![canvas.left, canvas.top, canvas.width, canvas.height, view.x, view.y, view.k].every(Number.isFinite)) return;
      if (!overlay) {
        overlay = doc.createElement("div");
        overlay.id = "canvas-retry-region-outline";
        overlay.setAttribute("aria-hidden", "true");
        overlay.style.cssText = "position:fixed;pointer-events:none;overflow:hidden;z-index:70;";
        frame = doc.createElement("div");
        frame.style.cssText = "position:absolute;box-sizing:border-box;border:2px dashed #3b82f6;border-radius:3px;pointer-events:none;";
        const label = doc.createElement("span");
        label.textContent = "\u91CD\u8BD5\u533A\u57DF";
        label.style.cssText = "position:absolute;top:2px;left:3px;padding:1px 5px;border-radius:3px;background:#2563eb;color:#fff;font:11px/1.5 system-ui;white-space:nowrap;";
        frame.append(label);
        overlay.append(frame);
        doc.body.append(overlay);
      }
      overlay.hidden = false;
      Object.assign(overlay.style, { left: `${canvas.left}px`, top: `${canvas.top}px`, width: `${canvas.width}px`, height: `${canvas.height}px` });
      Object.assign(frame.style, {
        left: `${view.x + rectangle.left * view.k}px`,
        top: `${view.y + rectangle.top * view.k}px`,
        width: `${(rectangle.right - rectangle.left) * view.k}px`,
        height: `${(rectangle.bottom - rectangle.top) * view.k}px`
      });
    }
    const control = {
      version: 1,
      snapshot,
      paint,
      refresh() {
        syncProject();
        publish(false);
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      setEnabled(value) {
        syncProject();
        if (enabled === !!value) return;
        enabled = !!value;
        if (enabled && candidate) rectangle = { ...candidate };
        persist();
        publish(true);
      },
      begin(id) {
        syncProject();
        if (id !== projectId || drawing) return;
        drawing = true;
        if (enabled) publish(true);
      },
      capture(id, selection) {
        syncProject();
        if (id !== projectId) return;
        const next = normalizeRetryRectangle(selection);
        const wasDrawing = drawing;
        drawing = false;
        if (next) {
          candidate = next;
          if (enabled) {
            rectangle = next;
            persist();
          }
        }
        if (enabled && (wasDrawing || next)) publish(true);
      },
      cancel(id) {
        syncProject();
        if (id !== projectId || !drawing) return;
        drawing = false;
        if (enabled) publish(true);
      }
    };
    win.CanvasSaveGuardRetryRegion = control;
    win.addEventListener("resize", () => paint());
    syncProject();
    return control;
  }

  // src/retry-panel.mjs
  var RETRY_PANEL_VERSION = "1.6.0";
  function installRetryPanel(document2 = globalThis.document) {
    const panelId = "local-canvas-retry-panel";
    const existing = document2.getElementById(panelId);
    if (existing?.dataset.version === RETRY_PANEL_VERSION && existing.shadowRoot?.getElementById("auto-start")) {
      installPanelShortcutBoundary(existing, document2);
      return existing;
    }
    if (!document2.body) {
      document2.addEventListener("DOMContentLoaded", () => installRetryPanel(document2), { once: true });
      return;
    }
    const previousInterval = existing?.shadowRoot?.getElementById("interval")?.value;
    const previousAutoInterval = existing?.shadowRoot?.getElementById("auto-interval")?.value;
    if (existing) {
      existing.shadowRoot?.getElementById("auto-cancel")?.click();
      existing.shadowRoot?.getElementById("stop")?.click();
      existing.dispatchEvent(new document2.defaultView.Event("canvas-retry-upgrade"));
    }
    const panel = existing || document2.createElement("aside");
    panel.id = panelId;
    installPanelShortcutBoundary(panel, document2);
    panel.dataset.version = RETRY_PANEL_VERSION;
    Object.assign(panel.style, {
      position: "fixed",
      right: "16px",
      bottom: "84px",
      zIndex: "2147483647",
      pointerEvents: "none"
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
  <section aria-label="\u6279\u91CF\u91CD\u8BD5\u5DE5\u5177">
      <header><strong>\u6279\u91CF\u91CD\u8BD5 ${RETRY_PANEL_VERSION}</strong><button id="fold" type="button" aria-label="\u6536\u8D77\u6279\u91CF\u91CD\u8BD5\u5DE5\u5177">\u6536\u8D77</button></header>
    <div class="body">
    <div class="scope"><span>\u533A\u57DF\u91CD\u8BD5</span><button id="region-toggle" type="button" role="switch" aria-label="\u533A\u57DF\u91CD\u8BD5" aria-checked="false"><span></span></button></div>
    <p id="region-status" role="status"></p>
    <label>\u9010\u9879\u63D0\u4EA4\u95F4\u9694\uFF08\u79D2\uFF09<input id="interval" type="number" required min="0.2" max="60"
      step="0.1" value="1" aria-label="\u9010\u9879\u63D0\u4EA4\u95F4\u9694\uFF08\u79D2\uFF09"></label>
    <div class="actions manual-actions">
      <button id="start" type="button">\u91CD\u8BD5\u5F53\u524D\u5931\u8D25\u9879</button>
      <button id="expand" type="button" aria-label="\u5C55\u5F00\u6279\u91CF\u91CD\u8BD5\u8BBE\u7F6E">\u5C55\u5F00</button>
    </div>
    <label>\u81EA\u52A8\u95F4\u9694\uFF08\u79D2\uFF09<input id="auto-interval" type="number" required min="60"
      step="1" value="60" aria-label="\u81EA\u52A8\u91CD\u8BD5\u95F4\u9694\uFF08\u79D2\uFF09"></label>
    <div class="actions">
        <button id="auto-start" type="button" aria-pressed="false">\u81EA\u52A8\u91CD\u8BD5</button>
      <button id="auto-cancel" type="button" disabled>\u53D6\u6D88\u91CD\u8BD5</button>
    </div>
    <p id="auto-status" role="status" aria-live="polite">\u81EA\u52A8\u91CD\u8BD5\u5F85\u5F00\u542F</p>
    <p id="status" role="status" aria-live="polite">\u5C31\u7EEA</p>
    <details><summary>\u4F7F\u7528\u8BF4\u660E</summary>
    <p>\u81EA\u52A8\u6309\u5468\u671F\u63D0\u4EA4\u5F53\u524D\u5931\u8D25\u9879\uFF0C\u9010\u9879\u4F7F\u7528\u4E0A\u65B9\u63D0\u4EA4\u95F4\u9694\u3002\u4ECE\u6BCF\u8F6E\u7B2C\u4E00\u9879\u63D0\u4EA4\u65F6\u8BA1\u65F6\u3002</p>
    <p>\u5904\u7406\u72EC\u7ACB\u5931\u8D25\u9879\u548C\u5DF2\u5C55\u5F00\u56FE\u7247\u7EC4\u4E2D\u7684\u5931\u8D25\u9879\uFF0C\u6536\u8D77\u7EC4\u81EA\u52A8\u8DF3\u8FC7\uFF0C\u6BCF\u9879\u6BCF\u8F6E\u63D0\u4EA4\u4E00\u6B21\u3002\u91CD\u8BD5\u4F7F\u7528\u7F51\u7AD9\u73B0\u6709\u914D\u7F6E\uFF0C\u53EF\u80FD\u6D88\u8017\u989D\u5EA6\u3002</p>
    <p>\u624B\u52A8\u6309\u8BBE\u5B9A\u95F4\u9694\u63D0\u4EA4\u5F53\u524D\u5931\u8D25\u9879\u4E00\u8F6E\uFF0C\u751F\u6210\u7ED3\u679C\u8BF7\u67E5\u770B\u753B\u5E03\u3002</p>
    <p>\u5F00\u542F\u533A\u57DF\u91CD\u8BD5\u540E\uFF0CShift\uFF0B\u5DE6\u952E\u6846\u9009\u56FA\u5B9A\u753B\u5E03\u533A\u57DF\u3002\u624B\u52A8\u4E0E\u81EA\u52A8\u91CD\u8BD5\u90FD\u4F7F\u7528\u8BE5\u533A\u57DF\uFF0C\u533A\u57DF\u5185\u540E\u6765\u51FA\u73B0\u7684\u5931\u8D25\u9879\u4E5F\u4F1A\u53C2\u4E0E\u3002\u91CD\u65B0\u6846\u9009\u53EF\u66FF\u6362\u8303\u56F4\uFF0C\u6536\u8D77\u7684\u56FE\u7247\u7EC4\u8DF3\u8FC7\u3002</p>
    </details>
    </div>
  </section>`;
    document2.body.append(panel);
    const regionControl = installRetryRegion(document2);
    const foldButton = root.getElementById("fold");
    foldButton.addEventListener("click", () => {
      const closed = root.querySelector("section").classList.toggle("closed");
      foldButton.textContent = closed ? "\u5C55\u5F00" : "\u6536\u8D77";
      foldButton.setAttribute("aria-label", closed ? "\u5C55\u5F00\u6279\u91CF\u91CD\u8BD5\u5DE5\u5177" : "\u6536\u8D77\u6279\u91CF\u91CD\u8BD5\u5DE5\u5177");
      refreshCount();
      startButton.title = closed ? "\u70B9\u51FB\u91CD\u8BD5\uFF0C\u53F3\u952E\u5C55\u5F00\u8BBE\u7F6E" : "";
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
    const attempts = /* @__PURE__ */ new Map();
    const settingsKey = "canvas-retry-settings-v1";
    try {
      const settings = JSON.parse(localStorage.getItem(settingsKey) || "{}");
      intervalInput.value = previousInterval || settings.manualInterval || "1";
      autoIntervalInput.value = previousAutoInterval || settings.autoInterval || "60";
      if (!intervalInput.checkValidity()) intervalInput.value = "1";
      if (!autoIntervalInput.checkValidity()) autoIntervalInput.value = "60";
    } catch {
    }
    function saveSettings() {
      if (!intervalInput.checkValidity() || !autoIntervalInput.checkValidity()) return;
      try {
        localStorage.setItem(settingsKey, JSON.stringify({
          manualInterval: intervalInput.value,
          autoInterval: autoIntervalInput.value
        }));
      } catch {
      }
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
    function cancelAutoRetry(message = "\u81EA\u52A8\u91CD\u8BD5\u5DF2\u53D6\u6D88\u3002") {
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
        autoStatus.textContent = `\u4E0B\u6B21\u68C0\u67E5\u65F6\u95F4 ${time}`;
      }
    }
    async function runAutoRetry(session) {
      if (autoSession !== session) return;
      if (location.href !== session.url || !isCanvas()) {
        cancelAutoRetry("\u5DF2\u5207\u6362\u753B\u5E03\uFF0C\u81EA\u52A8\u91CD\u8BD5\u5DF2\u53D6\u6D88\u3002");
        return;
      }
      session.nextAt = 0;
      session.startedAt = null;
      autoStatus.textContent = "\u81EA\u52A8\u91CD\u8BD5\u6B63\u5728\u68C0\u67E5\u5E76\u63D0\u4EA4\u5931\u8D25\u9879\u2026";
      await run(session);
      if (autoSession !== session) return;
      if (location.href !== session.url) {
        cancelAutoRetry("\u5DF2\u5207\u6362\u753B\u5E03\uFF0C\u81EA\u52A8\u91CD\u8BD5\u5DF2\u53D6\u6D88\u3002");
        return;
      }
      session.nextAt = (session.startedAt ?? Date.now()) + session.delay;
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
        autoStatus.textContent = "\u8BF7\u5148\u6253\u5F00\u4E00\u4E2A\u753B\u5E03\u3002";
        return;
      }
      if (!autoIntervalInput.reportValidity() || !intervalInput.reportValidity()) return;
      const seconds = Number(autoIntervalInput.value);
      if (!Number.isSafeInteger(seconds) || seconds < 60 || !Number.isSafeInteger(Date.now() + seconds * 1e3)) {
        autoStatus.textContent = "\u8BF7\u8F93\u5165\u6709\u6548\u7684\u6574\u6570\u79D2\u6570\uFF0C\u6700\u5C1160\u79D2\u3002";
        return;
      }
      autoSession = {
        url: location.href,
        delay: seconds * 1e3,
        timer: null,
        nextAt: 0,
        startedAt: null,
        controller: null
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
        const toggles = node.querySelectorAll('button[aria-label="\u56FE\u7247\u7EC4\u5DF2\u6536\u8D77"]');
        if (Array.from(toggles).some((toggle) => toggle.closest("[data-node-id]") === node)) {
          return true;
        }
        node = node.parentElement?.closest("[data-node-id]");
      }
      return false;
    }
    function isRetry(button) {
      return button.textContent.trim() === "\u91CD\u8BD5" && !button.disabled && button.getAttribute("aria-disabled") !== "true" && !button.closest('[hidden], [aria-hidden="true"]') && !isInCollapsedGroup(button) && button.getClientRects().length > 0;
    }
    function retryButtons() {
      return Array.from(document2.querySelectorAll("[data-node-id] button")).filter(isRetry);
    }
    function currentRetryBridge() {
      const bridge = globalThis.CanvasSaveGuardRetry;
      const projectId = decodeURIComponent(location.pathname.split("/")[2] || "");
      return bridge?.projectId === projectId && typeof bridge.list === "function" && typeof bridge.retry === "function" ? bridge : null;
    }
    function retryTargets() {
      const scope = regionControl.snapshot();
      const bridge = currentRetryBridge();
      if (scope.enabled && (!scope.available || !scope.rectangle || scope.drawing)) return [];
      if (bridge) return bridge.list(scope.enabled ? scope.rectangle : void 0).map((nodeId) => ({ nodeId, bridge }));
      return retryButtons().map((button) => ({
        nodeId: button.closest("[data-node-id]").getAttribute("data-node-id"),
        button
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
        if (autoSession?.url === url) cancelAutoRetry("\u5DF2\u5207\u6362\u753B\u5E03\uFF0C\u81EA\u52A8\u91CD\u8BD5\u5DF2\u53D6\u6D88\u3002");
      }
      return !controller.signal.aborted;
    }
    function takeSnapshot() {
      const scope = regionControl.snapshot();
      const targets = retryTargets();
      const counts = /* @__PURE__ */ new Map();
      for (const { nodeId } of targets) {
        counts.set(nodeId, (counts.get(nodeId) || 0) + 1);
      }
      return targets.map((target) => {
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
        return bridge ? bridge.retry(item.nodeId, scope.enabled ? scope.rectangle : void 0) : false;
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
        setRunStatus("\u8BF7\u5148\u6253\u5F00\u4E00\u4E2A\u753B\u5E03\u3002");
        return;
      }
      if (!intervalInput.reportValidity()) {
        setRunStatus("\u8BF7\u586B\u5199\u6709\u6548\u7684\u9010\u9879\u63D0\u4EA4\u95F4\u9694\uFF0C\u8303\u56F4\u4E3A0.2\u81F360\u79D2\u3002");
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
        setRunStatus("\u6B63\u5728\u68C0\u67E5\u5F53\u524D\u5931\u8D25\u9879\u2026");
        const items = takeSnapshot();
        total = items.length;
        if (!total) {
          const scope = regionControl.snapshot();
          setRunStatus(scope.enabled && (!scope.available || !scope.rectangle || scope.drawing) ? "\u8BF7\u7ED3\u675F\u6846\u9009\u5E76\u56FA\u5B9A\u91CD\u8BD5\u533A\u57DF\u3002\u533A\u57DF\u91CD\u8BD5\u9700\u8981\u65B0\u7248\u753B\u5E03\u52A9\u624B\u63A5\u53E3\u3002" : `${scope.enabled ? "\u5F53\u524D\u533A\u57DF" : "\u5F53\u524D\u753B\u5E03"}\u6CA1\u6709\u53EF\u91CD\u8BD5\u7684\u5931\u8D25\u9879\uFF0C\u6536\u8D77\u7684\u56FE\u7247\u7EC4\u5DF2\u8DF3\u8FC7\u3002`);
          return;
        }
        for (const item of items) {
          if (!stillOnCanvas(url, controller)) break;
          if (lastSubmission !== null) {
            let remaining = interval - (performance.now() - lastSubmission);
            while (remaining > 0 && stillOnCanvas(url, controller)) {
              setRunStatus(`\u5DF2\u63D0\u4EA4 ${submitted} / ${total} \u9879\uFF0C\u6309 ${interval / 1e3} \u79D2\u95F4\u9694\u7B49\u5F85\u4E0B\u4E00\u9879\u3002`);
              await pause(Math.min(remaining, 1e3), signal);
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
          setRunStatus(`\u5DF2\u63D0\u4EA4 ${submitted} / ${total} \u9879\uFF0C\u8DF3\u8FC7 ${skipped} \u9879\u3002`);
          await pause(0, signal);
        }
        const result = controller.scopeChanged ? "\u91CD\u8BD5\u8303\u56F4\u5DF2\u66F4\u65B0\uFF0C\u672C\u8F6E\u5DF2\u505C\u6B62" : signal.aborted ? "\u5DF2\u505C\u6B62" : "\u672C\u8F6E\u63D0\u4EA4\u7ED3\u675F";
        setRunStatus(`${result}\u3002\u5DF2\u63D0\u4EA4 ${submitted} / ${total} \u9879\uFF0C\u8DF3\u8FC7 ${skipped} \u9879\u3002
\u751F\u6210\u7ED3\u679C\u8BF7\u67E5\u770B\u753B\u5E03\u3002`);
      } catch (error) {
        console.error("[Canvas Retry]", error);
        setRunStatus(`\u64CD\u4F5C\u4E2D\u65AD\u3002\u5DF2\u63D0\u4EA4 ${submitted} \u9879\u3002
${error.message}`);
      } finally {
        clearInterval(navigationCheck);
        if (session) {
          session.controller = null;
          if (session.cancelMessage && !autoSession) runStatus.textContent = session.cancelMessage;
        } else {
          manualController = null;
          if (signal.aborted) status.textContent = `${controller.scopeChanged ? "\u91CD\u8BD5\u8303\u56F4\u5DF2\u66F4\u65B0\uFF0C\u672C\u8F6E\u5DF2\u505C\u6B62" : "\u5DF2\u505C\u6B62"}\u3002\u5DF2\u63D0\u4EA4 ${submitted} / ${total} \u9879\u3002`;
        }
        updateControls();
        refreshCount();
      }
    }
    function refreshCount() {
      if (autoSession && location.href !== autoSession.url) {
        cancelAutoRetry("\u5DF2\u5207\u6362\u753B\u5E03\uFF0C\u81EA\u52A8\u91CD\u8BD5\u5DF2\u53D6\u6D88\u3002");
      }
      updateAutoStatus();
      const scope = regionControl.snapshot();
      regionToggle.disabled = !scope.available && !scope.enabled;
      regionToggle.setAttribute("aria-checked", String(scope.enabled));
      regionToggle.title = scope.available ? "\u5F00\u542F\u540E\u4F7F\u7528\u56FA\u5B9A\u6846\u9009\u533A\u57DF\uFF0C\u5173\u95ED\u540E\u6062\u590D\u5168\u753B\u5E03\u91CD\u8BD5" : "\u8BF7\u91CD\u65B0\u52A0\u8F7D\u753B\u5E03\u52A9\u624B\u6269\u5C55\u5E76\u5237\u65B0\u753B\u5E03\uFF0C\u542F\u7528\u533A\u57DF\u63A5\u53E3";
      regionStatus.textContent = scope.enabled ? !scope.available ? "\u7B49\u5F85\u65B0\u7248\u753B\u5E03\u63A5\u53E3\uFF0C\u8BF7\u4FDD\u5B58\u540E\u5237\u65B0\u753B\u5E03" : scope.drawing ? "\u6B63\u5728\u6846\u9009\u533A\u57DF\u2026" : scope.rectangle ? `\u533A\u57DF\u5DF2\u56FA\u5B9A \xB7 ${Math.round(scope.rectangle.right - scope.rectangle.left)} \xD7 ${Math.round(scope.rectangle.bottom - scope.rectangle.top)} \xB7 Shift\uFF0B\u5DE6\u952E\u91CD\u65B0\u6846\u9009` : "Shift\uFF0B\u5DE6\u952E\u6846\u9009\u91CD\u8BD5\u533A\u57DF" : "\u5168\u753B\u5E03\u91CD\u8BD5";
      autoStartButton.textContent = scope.enabled ? "\u533A\u57DF\u81EA\u52A8\u91CD\u8BD5" : "\u81EA\u52A8\u91CD\u8BD5";
      regionControl.paint();
      panel.hidden = !isCanvas();
      if (!panel.isConnected && document2.body) document2.body.append(panel);
      const guard = document2.getElementById("canvas-save-guard");
      panel.style.bottom = guard && getComputedStyle(guard).display !== "none" ? Math.max(18, window.innerHeight - guard.getBoundingClientRect().top + 10) + "px" : "18px";
      if (root.querySelector("section").classList.contains("closed")) {
        startButton.textContent = scope.enabled ? "\u533A\u57DF\u91CD\u8BD5" : "\u91CD\u8BD5";
      } else if (!manualController) {
        startButton.textContent = `${scope.enabled ? "\u91CD\u8BD5\u533A\u57DF\u5931\u8D25\u9879" : "\u91CD\u8BD5\u5F53\u524D\u5931\u8D25\u9879"}\uFF08${retryTargets().length}\uFF09`;
      }
    }
    startButton.addEventListener("click", () => run());
    startButton.addEventListener("contextmenu", (event) => {
      if (!root.querySelector("section").classList.contains("closed")) return;
      event.preventDefault();
      foldButton.click();
    });
    autoStartButton.addEventListener("click", startAutoRetry);
    autoCancelButton.addEventListener("click", () => cancelAutoRetry());
    regionToggle.addEventListener("click", () => regionControl.setEnabled(!regionControl.snapshot().enabled));
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

  // src/retry-userscript.mjs
  installRetryPanel(document);
})();
