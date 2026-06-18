export const state = { keys: [], logs: [], audit: [], observability: null, config: null, trace: null, keyFailures: {}, selectedId: null, timer: null, events: null, eventRefreshPending: false, keyPage: 1, keyPageSize: 50, pageKeyIds: [], problemKeyIds: [], lastOperation: null, secretDisplay: localStorage.getItem('exaSecretDisplay') || 'plain', activeTab: 'overview', keyFilter: 'All', keySort: { column: null, direction: 'asc' }, selectedKeyIds: [] };
export const token = document.querySelector('#token');
export const loginToken = document.querySelector('#loginToken');
const savedToken = sessionStorage.getItem('exaProxyAdminToken') || localStorage.getItem('exaProxyAdminToken') || '';
token.value = savedToken;
loginToken.value = savedToken;

export const el = (id) => document.getElementById(id);
export const fmt = (value) => Number(value || 0).toLocaleString();
export const pct = (part, total) => total > 0 ? ((part / total) * 100).toFixed(2) + '%' : '0%';
export const ms = (value) => value ? fmt(value) + ' 毫秒' : '0 毫秒';
export const stamp = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-';
export const statusText = { Healthy: '健康', Cooldown: '冷却中', Disabled: '已禁用' };
export const filterMap = { '全部状态': 'All', '健康': 'Healthy', '冷却中': 'Cooldown', '已禁用': 'Disabled', '仅异常': 'Problem' };
export const reasonText = { ok: '正常', rate_limit: '限流', timeout: '上游超时', upstream_timeout: '上游超时', transient_status: '临时错误', client_status: '上游拒绝', connection_error: '连接异常', upstream_5xx: '上游错误', upstream_error: '上游错误', unknown_error: '未知错误', no_healthy_keys: '无可用密钥', manual_reset: '人工重置', route_forbidden: '路径未授权', unauthorized: '未授权' };
export const labelOf = (value) => value ? (reasonText[value] || String(value).replaceAll('_', ' ')) : '-';

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

export function maskSecret(value) {
  const text = String(value || '');
  if (!text || text === '-') return '-';
  if (state.secretDisplay === 'plain') return text;
  return text.length <= 12 ? text.slice(0, 3) + '••••' + text.slice(-3) : text.slice(0, 8) + '••••••' + text.slice(-6);
}

export const displayLabel = (key) => maskSecret(key?.displayId || key?.id || '-');
export const rawDisplayLabel = (key) => key?.displayId || key?.id || '-';
export const rawKeyDisplayAllowed = (key) => Boolean(key?.rawKeyDisplayAllowed);
export const displayLabelById = (id) => displayLabel(state.keys.find((item) => item.id === id) || { id });

export const cooldownLeft = (until) => {
  const left = Math.max(0, Number(until || 0) - Date.now());
  if (!left) return '-';
  const minutes = Math.floor(left / 60000);
  const seconds = Math.ceil((left % 60000) / 1000);
  return (minutes ? minutes + ' 分 ' : '') + seconds + ' 秒';
};

export function statusOf(key) {
  if (!key.enabled) return 'Disabled';
  if (Number(key.cooldownUntil || 0) > Date.now()) return 'Cooldown';
  return 'Healthy';
}

export function classForStatus(status) {
  if (status === 'Healthy') return 'good';
  if (status === 'Cooldown') return 'warn';
  return 'bad';
}

export function observedRequestsFor(key) {
  const success = Number(key.successCount || 0);
  const failures = Number(key.failureCount || 0);
  const rateLimits = Number(key.rateLimitCount || 0);
  const timeouts = Number(key.timeoutCount || 0);
  return Math.max(Number(key.totalRequests || 0), success + failures, success + rateLimits + timeouts);
}

export function computeTotals(keys) {
  return keys.reduce((totals, key) => {
    const keyStatus = statusOf(key);
    const success = Number(key.successCount || 0);
    const failures = Number(key.failureCount || 0);
    const rateLimits = Number(key.rateLimitCount || 0);
    const timeouts = Number(key.timeoutCount || 0);
    const observedRequests = observedRequestsFor(key);
    totals.requests += observedRequests;
    totals.success += success;
    totals.failures += failures;
    totals.rateLimits += rateLimits;
    totals.timeouts += timeouts;
    totals.latency += Number(key.lastLatencyMs || 0);
    totals.latencyCount += key.lastLatencyMs ? 1 : 0;
    if (key.enabled) totals.active += 1;
    if (keyStatus === 'Healthy') totals.healthy += 1;
    if (keyStatus === 'Cooldown') totals.cooldown += 1;
    if (keyStatus === 'Disabled') totals.disabled += 1;
    return totals;
  }, { requests: 0, success: 0, failures: 0, rateLimits: 0, timeouts: 0, latency: 0, latencyCount: 0, active: 0, healthy: 0, cooldown: 0, disabled: 0 });
}

export function setWidth(id, value) {
  el(id).style.width = Math.max(0, Math.min(100, value)) + '%';
}

export function isOperationalLog(log) {
  if (!log) return false;
  if (log.path === '/favicon.ico' || String(log.path || '').startsWith('/_proxy/')) return false;
  if ((log.errorCode === 'unauthorized' || log.errorCode === 'route_forbidden') && (!Array.isArray(log.keyIds) || log.keyIds.length === 0)) return false;
  return true;
}

export function currentRangeHours() {
  return Number(el('timeRange')?.value || 24);
}

export function internalKeyIdFromFilter(value) {
  const query = String(value || '').trim().toLowerCase();
  if (!query) return '';
  const found = state.keys.find((key) => key.id.toLowerCase() === query || rawDisplayLabel(key).toLowerCase() === query || displayLabel(key).toLowerCase() === query);
  return found ? found.id : value;
}

export function debounce(fn, delay) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}
