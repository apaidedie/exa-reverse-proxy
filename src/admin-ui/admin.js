import { api, clearToken, currentSessionId, exportAudit, exportLogs, fetchConfigSummary, fetchKeyFailureSummary, fetchLogTrace, fetchLogs, fetchObservability, verifyAdminToken, verifyStoredSession } from './api.js';
import { debounce, displayLabelById, el, fmt, labelOf, loginToken, ms, rawKeyDisplayAllowed, stamp, state, token } from './state.js';
import { renderDetails, renderKeys, updateSummary } from './renderKeys.js';
import { renderAudit, renderLogTrace, renderLogs } from './renderLogs.js';
import { renderConfigSummary, renderObservability } from './renderObservability.js';

function showToast(message) {
  const toast = el('toast');
  toast.textContent = message;
  toast.style.display = 'block';
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.style.display = 'none'; }, 3200);
}

function updateBatchBar() {
  const bar = el('batchBar');
  const count = state.selectedKeyIds.length;
  if (bar) {
    bar.hidden = count === 0;
    const countEl = el('batchCount');
    if (countEl) countEl.textContent = '已选 ' + fmt(count) + ' 个密钥';
  }
}

function closeEventStream() {
  if (state.events) state.events.close();
  state.events = null;
  state.eventRefreshPending = false;
}

function showLogin(message = '') {
  document.querySelector('[data-login-screen]').hidden = false;
  document.querySelector('[data-console-shell]').hidden = true;
  el('loginError').textContent = message;
  if (state.timer) clearInterval(state.timer);
  closeEventStream();
  loginToken.focus();
}

function showConsole() {
  document.querySelector('[data-login-screen]').hidden = true;
  document.querySelector('[data-console-shell]').hidden = false;
  el('loginError').textContent = '';
  resetTimer();
  connectEventStream();
}

async function pruneLogs() {
  const days = Number(state.observability?.retention?.days || 14);
  const result = await api('/_proxy/logs/prune', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ days }) });
  showToast('已清理 ' + fmt(result.deleted || 0) + ' 条过期日志');
  await refresh();
}

async function loadKeyFailureSummary(id) {
  if (!id) return;
  const result = await fetchKeyFailureSummary(id);
  state.keyFailures[id] = result.summary;
}

async function loadLogTrace(requestId) {
  const result = await fetchLogTrace(requestId);
  state.trace = result;
  renderLogTrace();
}

function switchTab(tabId) {
  state.activeTab = tabId;
  document.querySelectorAll('.tab-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tabId));
  document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.tabPanel === tabId));
  const shell = document.querySelector('[data-console-shell]');
  if (shell) shell.classList.toggle('has-aside', tabId === 'keys');
  renderActiveTab(tabId);
}

function renderActiveTab(tabId) {
  if (tabId === 'overview') {
    updateSummary();
    renderObservability();
  } else if (tabId === 'keys') {
    renderKeys();
    renderDetails();
  } else if (tabId === 'logs') {
    renderLogs();
    renderLogTrace();
  } else if (tabId === 'audit') {
    renderAudit();
    renderConfigSummary();
  }
}

async function refresh() {
  const [keyData, logData, observabilityData, auditData, configData] = await Promise.all([
    api('/_proxy/keys'),
    fetchLogs(),
    fetchObservability(),
    api('/_proxy/audit?limit=12'),
    fetchConfigSummary()
  ]);
  state.keys = keyData.keys || [];
  state.logs = logData.logs || [];
  state.observability = observabilityData;
  state.audit = auditData.audit || [];
  state.config = configData || null;
  updateSummary();
  renderActiveTab(state.activeTab);
  if (state.activeTab === 'keys' && state.selectedId) await loadKeyFailureSummary(state.selectedId).catch(() => {});
  if (state.activeTab === 'keys') renderDetails();
}

async function batchKeyAction(action, ids) {
  const picked = Array.from(new Set(ids || [])).filter(Boolean);
  if (!picked.length) { showToast('没有可批量处理的密钥'); return; }
  const result = await api('/_proxy/keys/batch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ids: picked }) });
  showToast('批量操作完成：' + fmt((result.results || []).length) + ' 个密钥');
  await refresh();
}

async function keyAction(id, action) {
  if (action === 'toggle') {
    const key = state.keys.find((item) => item.id === id);
    action = key && key.enabled ? 'disable' : 'enable';
  }
  state.selectedId = id;
  if (action === 'select') {
    await loadKeyFailureSummary(id).catch(() => {});
    state.lastOperation = { id, tone: 'good', title: '详情', message: '已打开密钥 ' + displayLabelById(id) + ' 的详情。右侧面板已同步显示用量、冷却和最后错误。', time: stamp(Date.now()) };
    renderDetails();
    showToast('已打开密钥 ' + displayLabelById(id) + ' 详情');
    return;
  }
  if (action === 'copy') {
    const key = state.keys.find((item) => item.id === id);
    if (!rawKeyDisplayAllowed(key)) {
      state.lastOperation = { id, tone: 'warn', title: '复制', message: '当前环境未开启原始密钥显示。VPS 部署建议保持关闭。', time: stamp(Date.now()) };
      renderDetails();
      showToast('原始密钥显示已关闭');
      return;
    }
    const confirmed = window.confirm('将显示并复制原始 Exa API Key，此操作会写入管理员审计。继续？');
    if (!confirmed) return;
    const result = await api('/_proxy/keys/' + encodeURIComponent(id) + '/secret', { method: 'POST' });
    await navigator.clipboard.writeText(result.secret || '');
    state.lastOperation = { id, tone: 'good', title: '复制', message: '原始密钥已复制到剪贴板，并写入管理员审计。', time: stamp(Date.now()) };
    renderDetails();
    showToast('原始密钥已复制');
    return;
  }
  if (action === 'disable') {
    await api('/_proxy/keys/' + encodeURIComponent(id) + '/disable', { method: 'POST' });
    state.lastOperation = { id, tone: 'warn', title: '禁用', message: '密钥 ' + displayLabelById(id) + ' 已禁用，调度器不会继续分配新请求。', time: stamp(Date.now()) };
  }
  if (action === 'enable') {
    await api('/_proxy/keys/' + encodeURIComponent(id) + '/enable', { method: 'POST' });
    state.lastOperation = { id, tone: 'good', title: '启用', message: '密钥 ' + displayLabelById(id) + ' 已启用，可重新参与请求调度。', time: stamp(Date.now()) };
  }
  if (action === 'reset') {
    await api('/_proxy/keys/' + encodeURIComponent(id) + '/reset-circuit', { method: 'POST' });
    state.lastOperation = { id, tone: 'good', title: '重置', message: '密钥 ' + displayLabelById(id) + ' 的冷却诊断已重置，当前冷却状态会随刷新同步。', time: stamp(Date.now()) };
  }
  if (action === 'test') {
    state.lastOperation = { id, tone: 'warn', title: '测试中', message: '正在使用密钥 ' + displayLabelById(id) + ' 发起上游探测请求。', time: stamp(Date.now()) };
    renderDetails();
    const result = await api('/_proxy/keys/' + encodeURIComponent(id) + '/test', { method: 'POST' });
    const ok = Boolean(result.ok);
    state.lastOperation = { id, tone: ok ? 'good' : 'bad', title: '测试密钥', message: '测试密钥 ' + displayLabelById(id) + ' 完成：状态 ' + (result.status || '-') + '，延迟 ' + ms(result.latencyMs) + '，结果 ' + labelOf(result.reason) + '。', time: stamp(Date.now()) };
  }
  showToast('密钥 ' + displayLabelById(id) + ' 已更新');
  await refresh();
}

function parseImportText(text) {
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      // Try JSON: {"id":"...","value":"...","weight":1}
      if (line.startsWith('{')) {
        try { return JSON.parse(line); } catch { return { value: line }; }
      }
      const parts = line.split(':');
      if (parts.length >= 3) return { id: parts[0], value: parts.slice(1, -1).join(':'), weight: Number(parts[parts.length - 1]) || 1 };
      if (parts.length === 2) return { id: parts[0], value: parts[1] };
      return { value: line };
    });
}

function openImportModal() {
  el('importTextarea').value = '';
  el('importFileInput').value = '';
  el('importFileName').textContent = '';
  el('importPreview').textContent = '';
  el('confirmImport').disabled = false;
  el('confirmImport').textContent = '开始导入';
  el('importModal').classList.add('modal-open');
  el('importTextarea').focus();
}

function closeImportModal() {
  el('importModal').classList.remove('modal-open');
}

async function submitImport() {
  const text = el('importTextarea').value.trim();
  if (!text) { showToast('请先粘贴或导入密钥'); return; }
  const keys = parseImportText(text);
  if (!keys.length) { showToast('未解析到有效密钥'); return; }

  el('confirmImport').disabled = true;
  el('confirmImport').textContent = '导入中...';
  try {
    const result = await api('/_proxy/keys/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keys })
    });
    showToast('导入完成：成功 ' + fmt(result.imported) + '，跳过 ' + fmt(result.skipped) + (result.totalErrors ? '，错误 ' + fmt(result.totalErrors) : ''));
    closeImportModal();
    await refresh();
  } catch (error) {
    showToast('导入失败：' + error.message);
    el('confirmImport').disabled = false;
    el('confirmImport').textContent = '开始导入';
  }
}

function connectEventStream() {
  if (!window.EventSource || state.events || !currentSessionId()) return;
  const source = new EventSource('/_proxy/events?sessionId=' + encodeURIComponent(currentSessionId()));
  state.events = source;
  source.addEventListener('snapshot', () => {
    if (state.eventRefreshPending || document.querySelector('[data-console-shell]').hidden) return;
    state.eventRefreshPending = true;
    window.setTimeout(() => {
      refresh().catch(() => {}).finally(() => { state.eventRefreshPending = false; });
    }, 350);
  });
  source.onerror = () => {
    closeEventStream();
    window.setTimeout(connectEventStream, 5000);
  };
}

function resetTimer() {
  if (state.timer) clearInterval(state.timer);
  if (!document.querySelector('[data-console-shell]').hidden && el('autoRefresh').checked) state.timer = setInterval(() => refresh().catch(() => {}), Number(el('refreshInterval').value));
}

el('refresh').addEventListener('click', () => refresh().catch((error) => showToast(error.message)));
el('logout').addEventListener('click', () => { closeEventStream(); api('/_proxy/session', { method: 'DELETE' }).catch(() => {}).finally(() => { clearToken(); showLogin('已退出，请重新输入管理员令牌。'); }); });
el('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const value = loginToken.value.trim();
  if (!value) { el('loginError').textContent = '请输入管理员令牌。'; return; }
  el('loginButton').disabled = true;
  el('loginButton').textContent = '登录中...';
  try {
    await verifyAdminToken(value);
    showConsole();
    await refresh();
  } catch (error) {
    clearToken();
    showLogin(error.message || '登录失败，请检查管理员令牌。');
  } finally {
    el('loginButton').disabled = false;
    el('loginButton').innerHTML = '<span>↪</span>进入控制台';
  }
});
el('toggleLoginToken').addEventListener('click', () => {
  const visible = loginToken.type === 'text';
  loginToken.type = visible ? 'password' : 'text';
  el('toggleLoginToken').textContent = visible ? '显示' : '隐藏';
});
el('keySearch').addEventListener('input', debounce(() => { state.keyPage = 1; renderKeys(); }, 250));
el('logSearch').addEventListener('input', renderLogs);
el('logPathFilter').addEventListener('input', () => fetchLogs().then((data) => { state.logs = data.logs || []; renderLogs(); }).catch((error) => showToast(error.message)));
el('logKeyFilter').addEventListener('input', () => fetchLogs().then((data) => { state.logs = data.logs || []; renderLogs(); }).catch((error) => showToast(error.message)));
el('logStatusFilter').addEventListener('change', () => fetchLogs().then((data) => { state.logs = data.logs || []; renderLogs(); }).catch((error) => showToast(error.message)));
el('applyLogFilters').addEventListener('click', () => fetchLogs().then((data) => { state.logs = data.logs || []; renderLogs(); }).catch((error) => showToast(error.message)));
el('exportLogs').addEventListener('click', exportLogs);
el('exportAudit').addEventListener('click', exportAudit);
el('pruneLogs').addEventListener('click', () => pruneLogs().catch((error) => showToast(error.message)));
el('timeRange').addEventListener('change', () => refresh().catch((error) => showToast(error.message)));
el('batchTestPage').addEventListener('click', () => batchKeyAction('test', state.pageKeyIds).catch((error) => showToast(error.message)));
el('batchDisableProblems').addEventListener('click', () => batchKeyAction('disable', state.problemKeyIds).catch((error) => showToast(error.message)));
el('bulkImportBtn').addEventListener('click', openImportModal);
el('closeImportModal').addEventListener('click', closeImportModal);
el('cancelImport').addEventListener('click', closeImportModal);
el('confirmImport').addEventListener('click', () => submitImport().catch((error) => showToast(error.message)));
el('importTextarea').addEventListener('input', () => {
  const text = el('importTextarea').value.trim();
  const lines = text ? text.split(/\r?\n/).filter((l) => l.trim()).length : 0;
  el('importPreview').textContent = lines ? '已识别 ' + lines + ' 行密钥' : '';
});
el('importFileInput').addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (!file) return;
  el('importFileName').textContent = file.name;
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result || '');
    el('importTextarea').value = text;
    el('importTextarea').dispatchEvent(new Event('input'));
  };
  reader.readAsText(file);
});
el('importModal').addEventListener('click', (event) => {
  if (event.target === el('importModal')) closeImportModal();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && el('importModal').classList.contains('modal-open')) closeImportModal();
});
el('toggleSecretDisplay').addEventListener('click', () => {
  state.secretDisplay = state.secretDisplay === 'plain' ? 'masked' : 'plain';
  localStorage.setItem('exaSecretDisplay', state.secretDisplay);
  renderKeys();
  renderLogs();
  renderDetails();
});
if (el('statusFilter')) el('statusFilter').addEventListener('change', () => { state.keyPage = 1; renderKeys(); });
el('prevKeyPage').addEventListener('click', () => { state.keyPage -= 1; renderKeys(); });
el('nextKeyPage').addEventListener('click', () => { state.keyPage += 1; renderKeys(); });
el('keysBody').addEventListener('click', (event) => {
  if (event.target.closest('.key-checkbox')) return;
  const row = event.target.closest('tr[data-key-id]');
  if (!row) return;
  const button = event.target.closest('button[data-action]');
  const action = button ? button.dataset.action : 'select';
  keyAction(row.dataset.keyId, action).catch((error) => showToast(error.message));
});
el('logsBody').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-trace-id]');
  if (!button) return;
  loadLogTrace(button.dataset.traceId).catch((error) => showToast(error.message));
});
el('detailsBody').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-detail-action]');
  if (!button || !state.selectedId) return;
  keyAction(state.selectedId, button.dataset.detailAction).catch((error) => showToast(error.message));
});
el('autoRefresh').addEventListener('change', resetTimer);
el('refreshInterval').addEventListener('change', resetTimer);

// Tab navigation
document.querySelector('.tab-bar').addEventListener('click', (event) => {
  const btn = event.target.closest('.tab-btn');
  if (btn) switchTab(btn.dataset.tab);
});

// Select all keys checkbox (in thead)
if (el('selectAllKeys')) el('selectAllKeys').addEventListener('change', (event) => {
  const checked = event.target.checked;
  state.selectedKeyIds = checked ? state.pageKeyIds.slice() : [];
  renderKeys();
  updateBatchBar();
});

// Delegated individual checkbox clicks on keysBody
el('keysBody').addEventListener('change', (event) => {
  const cb = event.target.closest('.key-checkbox');
  if (!cb) return;
  const id = cb.dataset.keyCheck;
  if (cb.checked) {
    if (!state.selectedKeyIds.includes(id)) state.selectedKeyIds.push(id);
  } else {
    state.selectedKeyIds = state.selectedKeyIds.filter((k) => k !== id);
  }
  updateBatchBar();
});

// Page size selector
if (el('keyPageSize')) el('keyPageSize').addEventListener('change', (event) => {
  state.keyPageSize = Number(event.target.value);
  state.keyPage = 1;
  renderKeys();
});

// Jump to page
if (el('jumpKeyPage')) el('jumpKeyPage').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  const page = Number(event.target.value);
  const maxPage = Math.max(1, Math.ceil(state.keys.length / state.keyPageSize));
  if (page >= 1 && page <= maxPage) { state.keyPage = page; renderKeys(); }
  event.target.value = '';
});

// Batch action bar buttons
if (el('batchEnableSelected')) el('batchEnableSelected').addEventListener('click', () => batchKeyAction('enable', state.selectedKeyIds).catch((e) => showToast(e.message)));
if (el('batchDisableSelected')) el('batchDisableSelected').addEventListener('click', () => batchKeyAction('disable', state.selectedKeyIds).catch((e) => showToast(e.message)));
if (el('batchResetSelected')) el('batchResetSelected').addEventListener('click', () => batchKeyAction('reset', state.selectedKeyIds).catch((e) => showToast(e.message)));
if (el('batchTestSelected')) el('batchTestSelected').addEventListener('click', () => batchKeyAction('test', state.selectedKeyIds).catch((e) => showToast(e.message)));

// Filter chips
if (el('keyFilterChips')) el('keyFilterChips').addEventListener('click', (event) => {
  const chip = event.target.closest('.chip');
  if (!chip) return;
  state.keyFilter = chip.dataset.chip || 'All';
  state.keyPage = 1;
  renderKeys();
});

// Sortable column headers
document.querySelector('.key-table-scroll thead').addEventListener('click', (event) => {
  const th = event.target.closest('th.sortable');
  if (!th) return;
  const column = th.dataset.sort;
  if (state.keySort.column === column) {
    state.keySort.direction = state.keySort.direction === 'asc' ? 'desc' : 'asc';
  } else {
    state.keySort = { column, direction: 'asc' };
  }
  renderKeys();
});

showLogin();
if (currentSessionId()) {
  verifyStoredSession()
    .then(async () => { showConsole(); await refresh(); })
    .catch(() => { clearToken(); showLogin(); });
} else if (token.value) {
  verifyAdminToken(token.value)
    .then(async () => { showConsole(); await refresh(); })
    .catch(() => { clearToken(); showLogin(); });
}
