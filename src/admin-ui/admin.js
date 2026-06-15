import { api, clearToken, currentSessionId, exportAudit, exportLogs, fetchConfigSummary, fetchKeyFailureSummary, fetchLogTrace, fetchLogs, fetchObservability, verifyAdminToken, verifyStoredSession } from './api.js';
import { displayLabelById, el, fmt, labelOf, loginToken, ms, rawKeyDisplayAllowed, stamp, state, token } from './state.js';
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
  renderKeys();
  renderLogs();
  renderObservability();
  renderConfigSummary();
  renderAudit();
  renderLogTrace();
  if (state.selectedId) await loadKeyFailureSummary(state.selectedId).catch(() => {});
  renderDetails();
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
el('keySearch').addEventListener('input', () => { state.keyPage = 1; renderKeys(); });
el('logSearch').addEventListener('input', renderLogs);
el('logPathFilter').addEventListener('input', () => fetchLogs().then((data) => { state.logs = data.logs || []; renderLogs(); }).catch((error) => showToast(error.message)));
el('logKeyFilter').addEventListener('input', () => fetchLogs().then((data) => { state.logs = data.logs || []; renderLogs(); }).catch((error) => showToast(error.message)));
el('logStatusFilter').addEventListener('change', () => fetchLogs().then((data) => { state.logs = data.logs || []; renderLogs(); }).catch((error) => showToast(error.message)));
el('applyLogFilters').addEventListener('click', () => fetchLogs().then((data) => { state.logs = data.logs || []; renderLogs(); }).catch((error) => showToast(error.message)));
el('exportLogs').addEventListener('click', exportLogs);
el('exportAudit').addEventListener('click', exportAudit);
el('pruneLogs').addEventListener('click', () => pruneLogs().catch((error) => showToast(error.message)));
el('testWebhook').addEventListener('click', () => testWebhook().catch((error) => showToast(error.message)));
el('timeRange').addEventListener('change', () => refresh().catch((error) => showToast(error.message)));
el('batchTestPage').addEventListener('click', () => batchKeyAction('test', state.pageKeyIds).catch((error) => showToast(error.message)));
el('batchDisableProblems').addEventListener('click', () => batchKeyAction('disable', state.problemKeyIds).catch((error) => showToast(error.message)));
el('toggleSecretDisplay').addEventListener('click', () => {
  state.secretDisplay = state.secretDisplay === 'plain' ? 'masked' : 'plain';
  localStorage.setItem('exaSecretDisplay', state.secretDisplay);
  renderKeys();
  renderLogs();
  renderDetails();
});
el('statusFilter').addEventListener('change', () => { state.keyPage = 1; renderKeys(); });
el('prevKeyPage').addEventListener('click', () => { state.keyPage -= 1; renderKeys(); });
el('nextKeyPage').addEventListener('click', () => { state.keyPage += 1; renderKeys(); });
el('keysBody').addEventListener('click', (event) => {
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
