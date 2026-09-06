import { useSyncExternalStore } from "react";

export type SafeQuotaValue = number | string;

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
