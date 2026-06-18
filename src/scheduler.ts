import type { KeyConfig, ProxyConfig } from './app.js';
import type { KeyStats } from './state.js';

export type SchedulerKey = KeyConfig;

type KeyState = {
  key: SchedulerKey;
  disabled: boolean;
  cooldownUntil: number;
  cooldownReason: string | null;
  lastUsedAt: number;
  failureTimestamps: number[];
};

type AdaptiveRuntime = {
  score: number;
  weight: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class KeyScheduler {
  private readonly states = new Map<string, KeyState>();
  private readonly adaptive = new Map<string, AdaptiveRuntime>();
  private sequence: string[];
  private pointer = 0;
  private adaptiveSeqCache: { seq: string[]; timestamp: number } | null = null;
  private readonly CACHE_TTL = 1000; // 1 second cache for adaptive sequence
  private adaptiveUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  private adaptiveUpdatePending = false;

  constructor(keys: SchedulerKey[], private readonly strategy: ProxyConfig['selectionStrategy']) {
    for (const key of keys) {
      this.states.set(key.id, {
        key,
        disabled: !key.enabled,
        cooldownUntil: 0,
        cooldownReason: null,
        lastUsedAt: 0,
        failureTimestamps: []
      });
    }
    this.sequence = keys.flatMap((key) => Array.from({ length: strategy === 'weighted_round_robin' ? key.weight : 1 }, () => key.id));
  }

  private isEligible(state: KeyState, now: number, exclude: Set<string>): boolean {
    return !state.disabled && state.key.enabled && state.cooldownUntil <= now && !exclude.has(state.key.id);
  }

  private adaptiveRuntimeFor(state: KeyState): AdaptiveRuntime {
    return this.adaptive.get(state.key.id) ?? { score: state.key.weight, weight: state.key.weight };
  }

  private adaptiveSequence(now: number, exclude: Set<string>): string[] {
    // Use cache if available, recent, and no exclusions
    if (this.adaptiveSeqCache && (now - this.adaptiveSeqCache.timestamp) < this.CACHE_TTL && exclude.size === 0) {
      return this.adaptiveSeqCache.seq;
    }

    const seq = [...this.states.values()]
      .filter((state) => this.isEligible(state, now, exclude))
      .flatMap((state) => Array.from({ length: this.adaptiveRuntimeFor(state).weight }, () => state.key.id));

    // Cache only when no exclusions
    if (exclude.size === 0) {
      this.adaptiveSeqCache = { seq, timestamp: now };
    }

    return seq;
  }

  next(now: number, exclude: Set<string> = new Set()): SchedulerKey | undefined {
    if (this.strategy === 'least_recently_used') {
      const candidates = [...this.states.values()]
        .filter((state) => this.isEligible(state, now, exclude))
        .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
      const selected = candidates[0];
      if (!selected) return undefined;
      selected.lastUsedAt = now;
      return selected.key;
    }

    const sequence = this.strategy === 'adaptive_weighted' ? this.adaptiveSequence(now, exclude) : this.sequence;
    if (sequence.length === 0) return undefined;
    for (let checked = 0; checked < sequence.length; checked += 1) {
      const id = sequence[this.pointer % sequence.length];
      this.pointer += 1;
      const state = this.states.get(id);
      if (state && this.isEligible(state, now, exclude)) {
        state.lastUsedAt = now;
        return state.key;
      }
    }
    return undefined;
  }

  updateAdaptiveStats(stats: KeyStats[]): void {
    // Invalidate the adaptive sequence cache since stats changed
    this.adaptiveSeqCache = null;
    for (const stat of stats) {
      const state = this.states.get(stat.id);
      if (!state) continue;
      state.disabled = !stat.enabled;
      state.cooldownUntil = Math.max(0, Number(stat.cooldownUntil || 0));
      state.cooldownReason = state.cooldownUntil > 0 ? stat.cooldownReason : null;
      const total = Math.max(0, Number(stat.totalRequests || 0));
      if (total === 0) {
        this.adaptive.set(stat.id, { score: state.key.weight, weight: Math.max(1, state.key.weight) });
        continue;
      }

      const successRate = clamp(Number(stat.successCount || 0) / total, 0, 1);
      const failureRate = clamp(Number(stat.failureCount || 0) / total, 0, 1);
      const rateLimitRate = clamp(Number(stat.rateLimitCount || 0) / total, 0, 1);
      const timeoutRate = clamp(Number(stat.timeoutCount || 0) / total, 0, 1);
      const creditsExhaustedRate = clamp(Number(stat.creditsExhaustedCount || 0) / total, 0, 1);
      const latencyMs = Math.max(1, Number(stat.lastLatencyMs || 500));
      const reliabilityFactor = clamp(0.25 + successRate * 1.25, 0.25, 1.5);
      const latencyFactor = clamp(1000 / latencyMs, 0.25, 2.5);
      const lastStatus = Number(stat.lastStatus || 0);
      const statusPenalty = lastStatus === 429 ? 3 : lastStatus === 402 ? 4 : lastStatus >= 500 ? 1.5 : 0;
      const errorPenalty = stat.lastError ? 0.5 : 0;
      const penalty = 1 + failureRate * 3 + rateLimitRate * 6 + timeoutRate * 4 + creditsExhaustedRate * 8 + statusPenalty + errorPenalty;
      const score = clamp(state.key.weight * reliabilityFactor * latencyFactor / penalty, 0.05, 16);
      const weight = Math.round(clamp(score * 6, 1, 16));
      this.adaptive.set(stat.id, { score: Number(score.toFixed(4)), weight });
    }
  }

  /** Debounced adaptive stats update — at most once per second to avoid hot-path overhead */
  scheduleAdaptiveUpdate(state: { listKeyStats(): KeyStats[] }): void {
    if (this.adaptiveUpdatePending) return;
    this.adaptiveUpdatePending = true;
    if (this.adaptiveUpdateTimer) return; // already scheduled
    this.adaptiveUpdateTimer = setTimeout(() => {
      this.adaptiveUpdateTimer = null;
      this.adaptiveUpdatePending = false;
      try {
        this.updateAdaptiveStats(state.listKeyStats());
      } catch {
        // Database may have been closed during shutdown — swallow silently
      }
    }, 1000);
    this.adaptiveUpdateTimer.unref?.();
  }

  dispose(): void {
    if (this.adaptiveUpdateTimer) {
      clearTimeout(this.adaptiveUpdateTimer);
      this.adaptiveUpdateTimer = null;
      this.adaptiveUpdatePending = false;
    }
  }

  getById(id: string, now: number): SchedulerKey | undefined {
    const state = this.states.get(id);
    if (!state || !this.isEligible(state, now, new Set())) return undefined;
    state.lastUsedAt = now;
    return state.key;
  }

  setDisabled(id: string, disabled: boolean): void {
    const state = this.states.get(id);
    if (state) state.disabled = disabled;
  }

  coolDown(id: string, untilMs: number, _now: number, reason: string): void {
    const state = this.states.get(id);
    if (!state) return;
    state.cooldownUntil = untilMs;
    state.cooldownReason = untilMs > 0 ? reason : null;
    if (untilMs === 0) state.failureTimestamps = [];
  }

  recordSuccess(id: string): void {
    const state = this.states.get(id);
    if (state) state.failureTimestamps = [];
  }

  recordFailure(id: string, now: number, threshold: number, windowMs: number, cooldownMs: number, reason: string): number | undefined {
    const state = this.states.get(id);
    if (!state) return undefined;
    // Filter old timestamps and limit array size to prevent memory leaks
    state.failureTimestamps = [...state.failureTimestamps, now]
      .filter((timestamp) => now - timestamp <= windowMs)
      .slice(-Math.max(threshold * 2, 100)); // Keep at most threshold*2 or 100 entries
    if (threshold > 0 && state.failureTimestamps.length >= threshold) {
      const until = now + cooldownMs;
      this.coolDown(id, until, now, reason);
      return until;
    }
    return undefined;
  }

  snapshot(now: number = Date.now()): Array<Record<string, unknown>> {
    return [...this.states.values()].map((state) => ({
      id: state.key.id,
      weight: state.key.weight,
      enabled: state.key.enabled && !state.disabled,
      coolingDown: state.cooldownUntil > now,
      cooldownUntil: state.cooldownUntil,
      cooldownReason: state.cooldownReason,
      lastUsedAt: state.lastUsedAt,
      adaptiveScore: this.adaptiveRuntimeFor(state).score,
      adaptiveWeight: this.adaptiveRuntimeFor(state).weight
    }));
  }

  private rebuildSequence(): void {
    this.sequence = [...this.states.values()].flatMap((state) =>
      Array.from({ length: this.strategy === 'weighted_round_robin' ? state.key.weight : 1 }, () => state.key.id)
    );
    this.pointer = 0;
    this.adaptiveSeqCache = null;
  }

  addKey(key: SchedulerKey): void {
    if (this.states.has(key.id)) return;
    this.states.set(key.id, {
      key,
      disabled: !key.enabled,
      cooldownUntil: 0,
      cooldownReason: null,
      lastUsedAt: 0,
      failureTimestamps: []
    });
    this.rebuildSequence();
  }

  addKeys(keys: SchedulerKey[]): number {
    let added = 0;
    for (const key of keys) {
      if (this.states.has(key.id)) continue;
      this.states.set(key.id, {
        key,
        disabled: !key.enabled,
        cooldownUntil: 0,
        cooldownReason: null,
        lastUsedAt: 0,
        failureTimestamps: []
      });
      added++;
    }
    if (added > 0) this.rebuildSequence();
    return added;
  }

  removeKey(id: string): void {
    if (!this.states.has(id)) return;
    this.states.delete(id);
    this.adaptive.delete(id);
    this.rebuildSequence();
  }

  updateKey(id: string, patch: { value?: string; weight?: number; enabled?: boolean }): void {
    const state = this.states.get(id);
    if (!state) return;
    let needsRebuild = false;
    if (patch.value !== undefined) {
      state.key = { ...state.key, value: patch.value };
    }
    if (patch.weight !== undefined && patch.weight !== state.key.weight) {
      state.key = { ...state.key, weight: patch.weight };
      needsRebuild = true;
    }
    if (patch.enabled !== undefined) {
      state.key = { ...state.key, enabled: patch.enabled };
      state.disabled = !patch.enabled;
    }
    if (needsRebuild) this.rebuildSequence();
    else this.adaptiveSeqCache = null;
  }

  getKey(id: string): SchedulerKey | undefined {
    return this.states.get(id)?.key;
  }
}
