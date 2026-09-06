import { useSyncExternalStore } from "react";

export type SafeQuotaValue = number | string;

export type ZaiModelUsageDetail = {
  modelCode: string;
  label: string;
  usage?: SafeQuotaValue;
};

export type ZaiQuotaWindow = {
  id: string;
  label?: "5-hour" | "Weekly";
  type: string;
  unit: number;
  percentage?: number;
  percentRemaining?: number;
  currentValue?: SafeQuotaValue;
  usage?: SafeQuotaValue;
  nextResetTime?: string | number;
  resetAt?: string;
  usageDetails?: Array<{ modelCode?: string; usage?: SafeQuotaValue }>;
};

export type ZaiQuotaFailure = {
  status:
    | "authentication-required"
    | "rate-limit"
    | "service-error"
    | "malformed-response"
    | "unavailable";
  message: string;
  httpStatus?: number;
  retryAt?: string;
  diagnostic?: "timeout" | "network" | "response-too-large";
};

export type ZaiQuotaSnapshot = {
  schemaVersion: 1;
  source: "zai-quota-api";
  endpoint: "https://api.z.ai/api/monitor/usage/quota/limit";
  credentialSource: "zai-coding-cn-env" | "baby-menu-keychain";
  windows: ZaiQuotaWindow[];
  refreshedAt: string;
  stale: boolean;
};

export type ZaiQuotaResult =
  | {
      ok: true;
      status: "fresh" | "stale";
      checkedAt: string;
      data: ZaiQuotaSnapshot;
      warning?: ZaiQuotaFailure;
    }
  | ({ ok: false; checkedAt: string } & ZaiQuotaFailure);

type ZaiQuotaViewState = {
  refreshing: boolean;
  result: ZaiQuotaResult | null;
};

let state: ZaiQuotaViewState = { refreshing: false, result: null };
let refreshInFlight: Promise<void> | undefined;
const listeners = new Set<() => void>();

function emit(next: ZaiQuotaViewState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): ZaiQuotaViewState {
  return state;
}

export function useZaiQuota(): ZaiQuotaViewState {
  return useSyncExternalStore(subscribe, snapshot);
}

export function formatGlmModelLabel(modelCode: string): string {
  if (!modelCode) return modelCode;
  if (/^glm(-.*)?$/i.test(modelCode)) {
    return modelCode.replace(/^glm/i, "GLM").replace(/-([a-z])/g, (_, letter) => `-${letter.toUpperCase()}`);
  }
  return modelCode.toUpperCase();
}

export function formatResetCountdown(resetAt: string | undefined, nowMs: number = Date.now()): string | null {
  if (!resetAt) return null;
  const targetMs = Date.parse(resetAt);
  if (Number.isNaN(targetMs)) return null;
  const diffMs = targetMs - nowMs;
  if (diffMs <= 0) return null;
  const totalMinutes = Math.floor(diffMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const days = Math.floor(hours / 24);
  if (days > 0) {
    const remHours = hours % 24;
    return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${Math.max(1, minutes)}m`;
}

export function getModelUsageBreakdown(window: ZaiQuotaWindow): ZaiModelUsageDetail[] {
  if (!window.usageDetails || window.usageDetails.length === 0) return [];
  const result: ZaiModelUsageDetail[] = [];
  for (const detail of window.usageDetails) {
    if (detail.modelCode) {
      result.push({
        modelCode: detail.modelCode,
        label: formatGlmModelLabel(detail.modelCode),
        usage: detail.usage,
      });
    }
  }
  return result;
}

export async function refreshZaiQuota(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  emit({ ...state, refreshing: true });
  refreshInFlight = (async () => {
    let result: ZaiQuotaResult;
    try {
      const api = window.babyMenu;
      if (!api) throw new Error("bridge unavailable");
      result = await api.capabilities.invoke<ZaiQuotaResult>("zai-quota", "getQuota");
    } catch {
      result = {
        ok: false,
        status: "unavailable",
        checkedAt: new Date().toISOString(),
        message: "Z.ai quota is unavailable",
      };
    }
    emit({ refreshing: false, result });
  })().finally(() => {
    refreshInFlight = undefined;
  });
  return refreshInFlight;
}

export function resetZaiQuotaStoreForTests(): void {
  refreshInFlight = undefined;
  state = { refreshing: false, result: null };
  for (const listener of listeners) listener();
}
