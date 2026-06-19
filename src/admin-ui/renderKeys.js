import { classForStatus, computeTotals, cooldownLeft, displayLabel, displayLabelById, el, esc, filterMap, fmt, isOperationalLog, labelOf, ms, observedRequestsFor, pct, rawDisplayLabel, setWidth, stamp, state, statusOf, statusText } from './state.js';

function updateMetricMeters(totals) {
  const avgLatency = totals.latencyCount ? Math.round(totals.latency / totals.latencyCount) : 0;
  setWidth('usageMeter', totals.requests > 0 ? Math.min(100, Math.max(8, Math.log10(totals.requests + 1) * 24)) : 0);
  setWidth('successMeter', totals.requests > 0 ? totals.success / totals.requests * 100 : 0);
  setWidth('rateLimitMeter', totals.requests > 0 ? totals.rateLimits / totals.requests * 100 : 0);
  setWidth('latencyMeter', avgLatency > 0 ? Math.min(100, avgLatency / 3000 * 100) : 0);
  setWidth('failureMeter', totals.requests > 0 ? totals.failures / totals.requests * 100 : 0);
}

function updateOpsStrip(totals) {
  const totalKeys = Math.max(state.keys.length, 1);
  const healthyRatio = totals.healthy / totalKeys * 100;
  const cooldownRatio = totals.cooldown / totalKeys * 100;
  const disabledRatio = totals.disabled / totalKeys * 100;
  const operationalLogs = state.logs.filter(isOperationalLog);
  const latestLog = operationalLogs[0] || null;
  const latestErrorLog = operationalLogs.find((log) => log.errorCode || Number(log.status) >= 400);
  const severity = totals.healthy === 0 && state.keys.length ? 'bad' : totals.cooldown || totals.failures ? 'warn' : 'good';
  const severityText = severity === 'good' ? '稳定' : severity === 'warn' ? '需关注' : '故障';
  const alertText = severity === 'good' ? '暂无需要人工处理的告警。' : severity === 'warn' ? '告警摘要：存在冷却中密钥或上游错误，请关注重试与失败趋势。' : '告警摘要：当前没有健康密钥，请立即恢复密钥池。';
  el('healthyKeyCount').textContent = String(totals.healthy);
  el('cooldownKeyCount').textContent = String(totals.cooldown);
  el('disabledKeyCount').textContent = String(totals.disabled);
  el('healthyPct').textContent = Math.round(healthyRatio) + '%';
  el('cooldownPct').textContent = Math.round(cooldownRatio) + '%';
  el('disabledPct').textContent = Math.round(disabledRatio) + '%';
  setWidth('healthyBar', healthyRatio);
  setWidth('cooldownBar', cooldownRatio);
  setWidth('disabledBar', disabledRatio);
  el('opsSeverity').className = 'badge ' + severity;
  el('opsSeverity').textContent = severityText;
  el('opsAlert').className = 'ops-alert ' + severity;
  el('opsAlert').textContent = alertText;
  el('latestStatus').className = 'badge ' + (latestErrorLog ? (Number(latestErrorLog.status) >= 500 ? 'bad' : 'warn') : 'good');
  el('latestStatus').textContent = latestErrorLog ? labelOf(latestErrorLog.errorCode || 'upstream_error') : '无异常';
  el('latestError').textContent = latestErrorLog ? labelOf(latestErrorLog.errorCode || latestErrorLog.status) : '-';
  el('latestPath').textContent = latestLog ? latestLog.path : '-';
  el('latestChain').textContent = latestLog && Array.isArray(latestLog.keyIds) ? latestLog.keyIds.map(displayLabelById).join(' -> ') : '-';
}

export function updateSummary() {
  const totals = computeTotals(state.keys);
  const errorRate = pct(totals.failures, totals.requests);
  const hasHealthyKey = state.keys.some((key) => statusOf(key) === 'Healthy');
  const serviceClass = hasHealthyKey ? '' : totals.active ? 'warn' : 'bad';
  el('serviceDot').className = 'status-dot ' + serviceClass;
  el('serviceStatus').textContent = hasHealthyKey ? '运行中' : totals.active ? '降级' : '无可用';
  el('activeKeys').textContent = String(totals.active);
  el('totalRequests').textContent = fmt(totals.requests);
  el('errorRate').textContent = errorRate;
  el('errorRate').className = 'summary-value ' + (totals.failures ? 'bad' : 'good');
  el('usageMetric').textContent = fmt(totals.requests);
  el('successMetric').textContent = pct(totals.success, totals.requests);
  el('rateLimitMetric').textContent = fmt(totals.rateLimits);
  el('latencyMetric').textContent = ms(totals.latencyCount ? Math.round(totals.latency / totals.latencyCount) : 0);
  el('failureMetric').textContent = fmt(totals.failures);
  el('keyCount').textContent = fmt(state.keys.length) + ' 个密钥';
  updateMetricMeters(totals);
  updateOpsStrip(totals);
}

export function renderKeys() {
  const query = el('keySearch').value.toLowerCase();
  const filter = state.keyFilter || 'All';
  el('toggleSecretDisplay').textContent = state.secretDisplay === 'plain' ? '脱敏显示' : '显示原文';

  // Compute chip counts across all keys
  let healthyCount = 0, cooldownCount = 0, disabledCount = 0, problemCount = 0;
  const rows = state.keys.filter((key) => {
    const status = statusOf(key);
    const problem = status === 'Cooldown' || status === 'Disabled' || Number(key.failureCount || 0) > 0 || Number(key.rateLimitCount || 0) > 0 || Number(key.timeoutCount || 0) > 0;
    key._problem = problem;
    if (status === 'Healthy') healthyCount++;
    else if (status === 'Cooldown') cooldownCount++;
    else if (status === 'Disabled') disabledCount++;
    if (problem) problemCount++;
    return (key.id.toLowerCase().includes(query) || rawDisplayLabel(key).toLowerCase().includes(query)) && (filter === 'All' || filter === status || (filter === 'Problem' && problem));
  });

  // Update chip counts and active state
  const chipCounts = { All: state.keys.length, Healthy: healthyCount, Cooldown: cooldownCount, Disabled: disabledCount, Problem: problemCount };
  document.querySelectorAll('#keyFilterChips .chip').forEach((chip) => {
    const value = chip.dataset.chip;
    chip.classList.toggle('active', value === filter);
    const countSpan = chip.querySelector('.chip-count');
    if (countSpan) countSpan.textContent = String(chipCounts[value] || 0);
  });

  // Apply sorting
  if (state.keySort.column) {
    const col = state.keySort.column;
    const dir = state.keySort.direction === 'desc' ? -1 : 1;
    const sortMap = { requests: 'totalRequests', success: 'successCount', failures: 'failureCount', rateLimits: 'rateLimitCount', timeouts: 'timeoutCount' };
    const field = sortMap[col] || col;
    rows.sort((a, b) => (Number(a[field] || 0) - Number(b[field] || 0)) * dir);
  }

  // Update sort indicators on th
  document.querySelectorAll('.key-table-scroll th.sortable').forEach((th) => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sort === state.keySort.column) {
      th.classList.add(state.keySort.direction === 'desc' ? 'sort-desc' : 'sort-asc');
    }
  });

  state.problemKeyIds = rows.filter((key) => key._problem).map((key) => key.id);
  const totalPages = Math.max(1, Math.ceil(rows.length / state.keyPageSize));
  state.keyPage = Math.min(Math.max(1, state.keyPage), totalPages);
  const start = (state.keyPage - 1) * state.keyPageSize;
  const pageRows = rows.slice(start, start + state.keyPageSize);
  state.pageKeyIds = pageRows.map((key) => key.id);
  el('keyPager').textContent = '显示 ' + fmt(rows.length ? start + 1 : 0) + '-' + fmt(start + pageRows.length) + ' / ' + fmt(rows.length) + ' 个密钥';
  el('keyPageLabel').textContent = '第 ' + fmt(state.keyPage) + ' / ' + fmt(totalPages) + ' 页';
  el('prevKeyPage').disabled = state.keyPage <= 1;
  el('nextKeyPage').disabled = state.keyPage >= totalPages;
  if (!rows.length) {
    el('keysBody').innerHTML = '<tr><td colspan="11" class="empty">没有匹配的密钥。</td></tr>';
    return;
  }
  el('keysBody').innerHTML = pageRows.map((key) => {
    const status = statusOf(key);
    const observedRequests = observedRequestsFor(key);
    const success = pct(key.successCount, observedRequests);
    const selected = key.id === state.selectedId ? ' class="selected"' : '';
    const checked = state.selectedKeyIds.includes(key.id) ? ' checked' : '';
    return '<tr data-key-id="' + esc(key.id) + '"' + selected + '>' +
      '<td class="col-check"><input type="checkbox" class="key-checkbox" data-key-check="' + esc(key.id) + '"' + checked + '></td>' +
      '<td class="mono">' + esc(displayLabel(key)) + '</td>' +
      '<td><button class="toggle ' + (key.enabled ? 'on' : '') + '" data-action="toggle" aria-label="切换密钥"></button></td>' +
      '<td>' + fmt(key.weight) + '</td>' +
      '<td>' + fmt(observedRequests) + '</td>' +
      '<td class="good">' + success + '</td>' +
      '<td class="bad">' + fmt(key.failureCount) + '</td>' +
      '<td class="warn">' + fmt(key.rateLimitCount) + '</td>' +
      '<td>' + fmt(key.timeoutCount) + '</td>' +
      '<td><span class="badge ' + classForStatus(status) + '">' + (status === 'Cooldown' ? cooldownLeft(key.cooldownUntil) : statusText[status]) + '</span></td>' +
      '<td class="action-cell"><button class="mini-btn" data-action="select" title="查看详情">详情</button><button class="mini-btn" data-action="reset" title="重置熔断">重置</button><button class="mini-btn primary-mini" data-action="test" title="测试密钥">测试</button></td>' +
    '</tr>';
  }).join('');
}

function pickDefaultKey() {
  if (state.selectedId && state.keys.some((item) => item.id === state.selectedId)) return state.selectedId;
  const cooling = state.keys.find((item) => statusOf(item) === 'Cooldown');
  return (cooling || state.keys[0])?.id || null;
}

function operationFor(key) {
  if (state.lastOperation && state.lastOperation.id === key.id) return state.lastOperation;
  return { id: key.id, tone: 'warn', title: '等待操作', message: '点击详情、重置或测试密钥后，这里会显示本次操作的状态、延迟和结果。', time: '-' };
}

function renderFailureSummary(key) {
  const summary = state.keyFailures[key.id];
  if (!summary) return '<div class="failure-reasons"><div class="reason-row"><span>摘要</span><strong>等待载入</strong></div></div>';
  const reasons = Object.entries(summary.reasons || {});
  if (!reasons.length) return '<div class="failure-reasons"><div class="reason-row"><span>摘要</span><strong>暂无最近失败</strong></div></div>';
  return '<div class="failure-reasons">' + reasons.map(([reason, count]) => '<div class="reason-row"><span>' + esc(labelOf(reason)) + '</span><strong>' + fmt(count) + ' 次</strong></div>').join('') +
    '<div class="reason-row"><span>最近状态</span><strong>' + esc(summary.lastStatus || '-') + '</strong></div>' +
    '<div class="reason-row"><span>最近时间</span><strong>' + esc(stamp(summary.lastFailureAt)) + '</strong></div></div>';
}

export function renderDetails() {
  state.selectedId = pickDefaultKey();
  const key = state.keys.find((item) => item.id === state.selectedId);
  if (!key) {
    el('detailsBody').innerHTML = '<div class="empty">选择一个密钥查看用量、冷却和最后错误。</div>';
    return;
  }
  const status = statusOf(key);
  const observedRequests = observedRequestsFor(key);
  const successRate = pct(key.successCount, observedRequests);
  const failureRate = pct(key.failureCount, observedRequests);
  const rateLimitRate = pct(key.rateLimitCount, observedRequests);
  const toggleAction = key.enabled ? 'disable' : 'enable';
  const toggleLabel = key.enabled ? '禁用密钥' : '启用密钥';
  const toggleClass = key.enabled ? 'danger-btn' : 'primary-btn';
  const cooldownState = status === 'Cooldown' ? '进行中' : '未冷却';
  const keyLabel = displayLabel(key);
  const incidentText = key.lastError ? '告警摘要：最近一次失败为 ' + labelOf(key.lastError) + '，状态码 ' + (key.lastStatus || '-') + '。' : '告警摘要：未记录最近失败。';
  const operation = operationFor(key);
  el('detailsBody').innerHTML =
    '<section class="detail-section"><div class="key-title"><strong class="mono">' + esc(keyLabel) + '</strong><span class="badge ' + classForStatus(status) + '">' + statusText[status] + '</span></div>' +
    '<div class="detail-row"><span>密钥 ID</span><span class="mono">' + esc(keyLabel) + '</span></div><div class="detail-row"><span>启用</span><span>' + (key.enabled ? '是' : '否') + '</span></div><div class="detail-row"><span>权重</span><span>' + fmt(key.weight) + '</span></div></section>' +
    '<section class="detail-section"><h3>近 24 小时</h3><div class="detail-kpis"><div class="detail-kpi"><span>请求</span><strong>' + fmt(observedRequests) + '</strong></div><div class="detail-kpi"><span>成功率</span><strong class="good">' + successRate + '</strong></div><div class="detail-kpi"><span>失败率</span><strong class="bad">' + failureRate + '</strong></div><div class="detail-kpi"><span>429</span><strong class="warn">' + rateLimitRate + '</strong></div><div class="detail-kpi"><span>超时</span><strong>' + pct(key.timeoutCount, observedRequests) + '</strong></div><div class="detail-kpi"><span>延迟</span><strong>' + ms(key.lastLatencyMs) + '</strong></div></div></section>' +
    '<section class="detail-section cooldown-card"><h3>冷却处理</h3><div class="detail-row"><span>状态</span><span>' + cooldownState + '</span></div><div class="detail-row"><span>原因</span><span>' + esc(labelOf(key.cooldownReason)) + '</span></div><div class="detail-row"><span>剩余</span><span class="' + classForStatus(status) + '">' + cooldownLeft(key.cooldownUntil) + '</span></div></section>' +
    '<section class="detail-section operation-feedback ' + esc(operation.tone) + '"><div class="feedback-title"><h3>操作反馈</h3><span>' + esc(operation.time) + '</span></div><div class="feedback-message">' + esc(operation.message) + '</div></section>' +
    '<section class="detail-section incident-timeline"><h3>失败与错误</h3>' + renderFailureSummary(key) + '<div class="ops-alert ' + (key.lastError ? 'bad' : 'good') + '">' + esc(incidentText) + '</div><div class="timeline-item"><span>错误码</span><strong class="' + (key.lastError ? 'bad' : '') + '">' + esc(labelOf(key.lastError)) + '</strong></div><div class="timeline-item"><span>状态码</span><strong>' + esc(key.lastStatus || '-') + '</strong></div><div class="timeline-item"><span>时间</span><strong>' + esc(stamp(key.lastFailureAt)) + '</strong></div></section>' +
    '<section class="detail-section actions"><button class="primary-btn" data-detail-action="test">测试密钥</button><button class="ghost-btn" data-detail-action="copy">复制密钥</button><button class="ghost-btn" data-detail-action="reset">重置冷却</button><button class="' + toggleClass + '" data-detail-action="' + toggleAction + '">' + toggleLabel + '</button></section>';
  renderKeys();
}
