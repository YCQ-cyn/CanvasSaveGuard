const STEP_COUNT = 7;

function releasedSpace(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function installCleanupProgress(guard, doc) {
  const previousProgress = guard.cleanupProgress;
  // Upgrading the display is safe while idle. Keep an active cleanup's
  // controller and token intact until its operation finishes.
  if (previousProgress?.statisticsVersion !== 12 && previousProgress?.read().status !== 'running') {
    let state = previousProgress?.read() || { status: 'idle' };
    let activeToken = null;
    let paintTimer = null;
    

    function paint() {
      clearTimeout(paintTimer);paintTimer=null;
      const root = doc.querySelector('#canvas-save-guard')?.shadowRoot?.querySelector('#cleanup-progress');
      if (!root) return;
      root.hidden = state.status === 'idle';
      if (state.status === 'idle') return;
      root.dataset.status = state.status;
      const title = root.querySelector('#cleanup-progress-title');
      const stage = root.querySelector('#cleanup-progress-stage');
      const bar = root.querySelector('progress');
      const count = root.querySelector('#cleanup-progress-count');
      const result = root.querySelector('#cleanup-progress-result');
      const running = state.status === 'running';
      title.textContent = running ? `清理中 · 第 ${state.step}/${STEP_COUNT} 步` : state.status === 'report' ? '媒体来源核对' : state.status === 'complete' ? state.title || '清理完成' : '清理未完成';
      stage.textContent = state.stage || '';
      if (state.percent === null) bar.removeAttribute('value');
      else bar.value = state.percent;
      bar.setAttribute('aria-valuetext', `${title.textContent}，${stage.textContent}`);
      bar.hidden = state.status === 'report';
      count.textContent = running && state.total !== null ? `${state.current}/${state.total} 项` : state.status === 'complete' ? '100%' : '';
      result.textContent = state.result || '';
      result.style.whiteSpace = 'pre-line';
      result.hidden = !state.result;
    }

    function update(progress) {
      if (state.status !== 'running') return;
      const step = progress.step;
      if (step < state.step) return;
      const total = Number.isFinite(progress.total) ? progress.total : null;
      const current = total === null ? 0 : Math.min(progress.current || 0, total);
      if (step === state.step && progress.stage === state.stage && total === state.total && current < state.current) return;
      const fraction = total === null ? null : total === 0 ? 1 : current / total;
      state = {
        status: 'running', step, stage: progress.stage, current, total,
        percent: fraction === null ? null : Math.min(99, Math.floor((step - 1 + fraction) / STEP_COUNT * 100)),
      };
      if(paintTimer===null)paintTimer=setTimeout(paint,80);
    }

    guard.cleanupProgress = {
      statisticsVersion: 12,
      read: () => ({ ...state }),
      paint,
      showReport(result) {
        if (state.status === 'running') return;
        activeToken = null;
        state = { status: 'report', stage: '只读检查 · 没有删除文件', result, percent: 100 };
        paint();
      },
      waiting(pending) {
        const shadow = doc.querySelector('#canvas-save-guard')?.shadowRoot;
        if (!shadow) return;
        let notice = shadow.getElementById('deletion-grace');
        if (!notice) {
          notice = doc.createElement('div'); notice.id = 'deletion-grace';
          notice.setAttribute('role', 'status');
          shadow.getElementById('status').after(notice);
        }
        notice.hidden = !pending?.total;
        if (pending?.total) {
          const messages = [];
          const objects = pending.objects ?? pending.total;
          if (objects) messages.push(`${objects} 个节点、子图或连线删除项保留一分钟，可按 Ctrl＋Z 撤销。`);
          if (pending.projects) messages.push(`${pending.projects} 张已删除画布的文件保留一分钟。`);
          messages.push(`最早于 ${new Date(pending.nextAt).toLocaleTimeString('zh-CN', { hour12: false })} 后清理。`);
          notice.textContent = messages.join('');
        }
      },
      start(token = null) {
        activeToken = token;
        state = { status: 'running', step: 1, stage: '等待当前保存完成', current: 0, total: null, percent: null };
        paint();
      },
      update,
      receive(token, progress) {
        if (token === activeToken) update(progress);
      },
      complete(result) {
        guard.cleanupProgress.waiting(result.waiting);
        const files = result.keys.length + (result.sessionFiles || 0);
        const bytes = result.bytes + (result.sessionBytes || 0);
        const stats = result.statistics;
        const describe = (label, group) => `${label} ${group.files} 个，${releasedSpace(group.bytes)}`;
        const lines = stats ? [
          describe('扫描到全站浏览器媒体', stats.scanned),
          describe('本次清理', stats.removed),
          describe('清理后保留', stats.retained),
          describe('  仍被引用', stats.inUse),
          describe('  无明确删除记录', stats.untracked),
          describe('  引用无法完整核对', stats.unverifiable),
          '媒体按编号计数，大小含原站、保护副本及缩略图，数据库额外占用另计。',
          '这不是当前屏幕的图片数；点击“缓存来源”可查看当前画布的本体、参考素材及具体引用。',
        ] : ['当前页面使用旧版清理接口，暂未提供数量和大小明细；请先保存完整 ZIP，再重新打开画布启用统计。'];
        if (result.deletionRecords) {
          const recorded = result.deletionRecords;
          lines.push(`当前画布累计记录手动删除 ${recorded.nodes} 个节点、${recorded.connections} 条连线、${recorded.images} 张组内图片，对应 ${recorded.media} 个媒体编号。`);
        }
        if (result.deletedProjects?.total) lines.push(`另核对 ${result.deletedProjects.total} 张已明确删除的画布，涉及 ${result.deletedProjects.media} 个媒体编号，已移除 ${result.deletedProjects.backups} 份画布保护副本。`);
        if (stats?.untracked.files) lines.push('“无明确删除记录”统计本网站中尚未匹配到删除来源的媒体，继续保留。');
        const waitingObjects = result.waiting?.objects ?? result.waiting?.total;
        if (waitingObjects) lines.push(`${waitingObjects} 个节点、子图或连线删除项仍在一分钟撤销保留期，文件与撤销记录继续保留。`);
        if (result.waiting?.projects) lines.push(`${result.waiting.projects} 张已删除画布仍在一分钟文件保留期。`);
        if (result.untrackedMedia?.length) {
          for (const item of result.untrackedMedia.slice(0, 5)) {
            const owner = item.owners[0];
            lines.push(`${item.key} · ${releasedSpace(item.bytes)} · ${owner ? `来源画布 ${owner.projectId}，节点 ${owner.nodeId}` : '此前未记录文件归属'}`);
          }
          if (result.untrackedMedia.length > 5) lines.push(`另外 ${result.untrackedMedia.length - 5} 个未匹配删除来源的媒体继续保留。`);
        }
        if (result.audit) {
          lines.push(`已核对临时地址 ${result.audit.checked} 个，按文件内容匹配 ${result.audit.contentMatched} 个。`);
          if (result.audit.unresolved.length) {
            lines.push(`仍有 ${result.audit.unresolved.length} 处引用无法完整核对。`);
            for (const item of result.audit.unresolved.slice(0, 3)) lines.push(`${item.path}：${item.reason}`);
          }
        }
        if (!files) lines.push(result.audit?.unresolved.length || stats?.unverifiable.files
          ? '本次未释放文件：存在无法核对的临时引用，暂停删除待清理媒体。'
          : stats ? '本次未找到可清理的明确删除媒体文件。' : '本次没有释放媒体文件。');
        if (result.sessionFiles) lines.push(`另释放临时会话文件 ${result.sessionFiles} 个，${releasedSpace(result.sessionBytes || 0)}。`);
        lines.push(`已清理 ${result.nodes} 个明确删除节点、${result.connections} 条明确删除连线的历史副本。清理过的删除操作无法撤销。`);
        if (result.images) lines.push(`另清理 ${result.images} 个已删除组内图片的历史副本。`);
        state = {
          status: 'complete', title: result.audit?.unresolved.length ? '核对完成 · 缓存暂留' : '清理完成', step: STEP_COUNT, stage: `已释放 ${files} 个文件，${releasedSpace(bytes)}`,
          current: 1, total: 1, percent: 100,
          result: lines.join('\n'),
        };
        activeToken = null;
        paint();
      },
      fail(error) {
        const button = '清理删除缓存';
        state = { ...state, status: 'failed', percent: state.percent ?? 0, stage: error.message || String(error), result: `可以重新点击“${button}”检查并重试。` };
        activeToken = null;
        paint();
      },
    };

    // Already-open v1.0.5 pages can display progress without replacing their
    // live storage or generation session. Their storage scan has no counters,
    // so that phase remains indeterminate until the next real operation starts.
    if (!previousProgress && guard.cleanupDeleted && !guard.cleanupDetailedProgress) {
      const original = guard.cleanupDeleted;
      guard.cleanupDeleted = async (...args) => {
        if (state.status === 'running') throw Error('清理正在进行，请等待完成。');
        guard.cleanupProgress.start();
        try {
          const result = await original(...args);
          guard.cleanupProgress.complete(result);
          return result;
        } catch (error) {
          guard.cleanupProgress.fail(error);
          throw error;
        }
      };
      const requests = new Map();
      window.addEventListener('message', event => {
        if (event.source !== window || state.status !== 'running') return;
        const message = event.data;
        if (['canvas-guard-cleanup', 'canvas-guard-cleanup-v2'].includes(message?.type)) {
          activeToken ||= message.data.token;
          if (activeToken !== message.data.token) return;
          requests.set(message.id, message.action);
          if (message.action === 'prepare') update({ step: 2, stage: '核对画布与撤销记录', total: null });
          if (message.action === 'releaseMedia') update({ step: 6, stage: '释放页面缓存', total: null });
          if (message.action === 'finish') update({ step: 7, stage: '恢复页面操作', total: null });
        } else if (message?.type === 'canvas-guard-cleanup-result') {
          const action = requests.get(message.id);
          requests.delete(message.id);
          if (action === 'prepare' && !message.error) update({ step: 3, stage: '正在核对引用并清理缓存', total: null });
        }
      });
    }
  }

  const shadow = doc.querySelector('#canvas-save-guard')?.shadowRoot;
  if (!shadow || shadow.querySelector('#cleanup-progress')) return;
  const root = doc.createElement('div');
  root.id = 'cleanup-progress';
  root.hidden = true;
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  root.innerHTML = `<style>
    #cleanup-progress { margin-top: 9px; padding-top: 8px; border-top: 1px solid #7f87914d; font-size: 12px; }
    #cleanup-progress[hidden] { display: none; }
    #cleanup-progress-title { font-weight: 600; }
    #cleanup-progress-stage, #cleanup-progress-result { margin-top: 4px; overflow-wrap: anywhere; }
    #cleanup-progress progress { display: block; width: 100%; height: 8px; margin-top: 7px; accent-color: #2563eb; }
    #cleanup-progress progress[hidden] { display: none; }
    #cleanup-progress-count { text-align: right; font-variant-numeric: tabular-nums; }
    #cleanup-progress[data-status="failed"] { color: light-dark(#b52525, #ffb2ac); }
    #cleanup-progress[data-status="complete"] progress { accent-color: #248445; }
  </style>
  <div id="cleanup-progress-title"></div>
  <div id="cleanup-progress-stage"></div>
  <progress max="100" aria-label="清理删除缓存进度"></progress>
  <div id="cleanup-progress-count"></div>
  <div id="cleanup-progress-result" hidden></div>`;
  shadow.querySelector('#status').after(root);
  guard.cleanupProgress.paint();
}
