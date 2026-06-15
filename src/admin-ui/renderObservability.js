import { el, esc, fmt, stamp, state } from './state.js';

export function renderRetention(data) {
  const retention = data.retention || {};
  const days = Number(retention.days || 0);
  const retained = Number(retention.retainedLogs || 0);
  const expired = Number(retention.expiredLogs || 0);
  const total = Number(retention.totalLogs || 0);
  el('retentionDays').textContent = days > 0 ? days + ' 天' : '关闭自动清理';
  el('retentionExpired').textContent = fmt(expired) + ' 条';
  el('retentionSummary').textContent = '当前存储 ' + fmt(total) + ' 条，保留窗口内 ' + fmt(retained) + ' 条。';
  el('retentionWindow').textContent = retention.cutoffMs ? '清理早于 ' + stamp(retention.cutoffMs) + ' 的请求日志。' : '自动清理未启用。';
}

export function renderConfigSummary() {
  const config = state.config || {};
  const strategyMap = { round_robin: '轮询', weighted_round_robin: '加权轮询', least_recently_used: '最少最近使用', adaptive_weighted: '自适应加权' };
  if (el('configListen')) el('configListen').textContent = config.listen || '-';
  if (el('configUpstream')) el('configUpstream').textContent = config.upstream || '-';
  if (el('configStrategy')) el('configStrategy').textContent = strategyMap[config.selectionStrategy] || config.selectionStrategy || '-';
  if (el('configAllowedPaths')) {
    const allowed = config.allowedPaths || {};
    el('configAllowedPaths').textContent = allowed.count ? '允许 ' + fmt(allowed.count) + ' 条路径：' + (allowed.preview || []).join('、') : '路径策略未载入';
  }
  if (el('configState')) el('configState').textContent = config.state?.backend === 'sqlite' ? 'SQLite 持久化' : (config.state?.backend || '-');
  if (el('configAffinity')) el('configAffinity').textContent = config.resourceAffinity ? '已启用资源亲和，后续资源请求优先使用创建密钥。' : '未启用资源亲和。';
  if (el('configRawKey')) el('configRawKey').textContent = config.rawKeyDisplayAllowed ? '允许按审计复制原始密钥' : '默认脱敏展示';
  if (el('configAdminHttps')) el('configAdminHttps').textContent = config.adminRequireHttps ? '要求 HTTPS 管理访问' : '未强制 HTTPS';
  if (el('configSessionTtl')) el('configSessionTtl').textContent = config.adminSessionTtlSeconds ? '会话有效期 ' + fmt(Math.round(config.adminSessionTtlSeconds / 3600)) + ' 小时。' : '会话策略未载入';
}

export function renderObservability() {
  const data = state.observability || { trends: [], alerts: [], window: { label: '近 24 小时' } };
  const trends = data.trends || [];
  const alerts = data.alerts || [];
  const maxRequests = Math.max(1, ...trends.map((bucket) => Number(bucket.requests || 0)));
  el('trendWindowLabel').textContent = data.window?.label || '近 24 小时';
  el('trendSummary').className = 'badge ' + (alerts.some((item) => item.severity === 'bad') ? 'bad' : alerts.length ? 'warn' : 'good');
  el('trendSummary').textContent = alerts.length ? '需关注' : '稳定';
  el('trendBars').innerHTML = trends.map((bucket) => {
    const height = Math.max(3, Math.round(Number(bucket.requests || 0) / maxRequests * 100));
    const failHeight = Number(bucket.requests || 0) ? Math.round(Number(bucket.failures || 0) / Number(bucket.requests || 1) * 100) : 0;
    const rateHeight = Number(bucket.requests || 0) ? Math.round(Number(bucket.rateLimits || 0) / Number(bucket.requests || 1) * 100) : 0;
    const title = new Date(bucket.bucketStart).toLocaleString('zh-CN', { hour12: false }) + ' 请求 ' + fmt(bucket.requests) + '，失败 ' + fmt(bucket.failures) + '，429 ' + fmt(bucket.rateLimits);
    return '<div class="trend-bar" title="' + esc(title) + '" style="height:' + height + '%"><span class="fail" style="height:' + failHeight + '%"></span><span class="rate" style="height:' + rateHeight + '%"></span></div>';
  }).join('') || '<div class="empty">暂无趋势数据。</div>';
  el('alertCount').textContent = fmt(alerts.length) + ' 条告警';
  el('alertList').innerHTML = alerts.length ? alerts.map((alert) => '<div class="alert-item ' + esc(alert.severity || 'warn') + '"><div class="alert-title"><span>' + esc(alert.title) + '</span><span class="badge ' + esc(alert.severity || 'warn') + '">' + (alert.severity === 'bad' ? '严重' : '关注') + '</span></div><div class="alert-message">' + esc(alert.message) + '</div></div>').join('') : '<div class="empty">暂无告警。</div>';
  renderRetention(data);
  renderConfigSummary();
}
