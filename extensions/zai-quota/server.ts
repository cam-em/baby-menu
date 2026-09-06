import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";

const ENDPOINT = "https://api.z.ai/api/monitor/usage/quota/limit";
const SOURCE = "zai-quota-api";
const KEYCHAIN_SERVICE = "com.kunchenguid.baby-menu.zai-quota";
const RESPONSE_LIMIT_BYTES = 64 * 1024;
const KEYCHAIN_OUTPUT_LIMIT_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = boundedTestTimeout(process.env.ZAI_QUOTA_TEST_TIMEOUT_MS, 15_000);
const CACHE_BINDING_KEY = randomBytes(32);

const STALE_ELIGIBLE_STATUSES = new Set([
  "rate-limit",
  "service-error",
  "malformed-response",
  "unavailable",
]);

let zaiQuotaInFlight: Promise<any> | undefined;
let zaiQuotaLastGoodCache: any;
let zaiQuotaLastGoodCredentialBinding: string | undefined;

class SafeQuotaFailure extends Error {
  status: string;
  httpStatus?: number;
  retryAt?: string;
  diagnostic?: string;

  constructor(status: string, message: string, options: { httpStatus?: number; retryAt?: string; diagnostic?: string } = {}) {
    super(message);
    this.status = status;
    this.httpStatus = options.httpStatus;
    this.retryAt = options.retryAt;
    this.diagnostic = options.diagnostic;
  }
}

function boundedTestTimeout(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 30_000 ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizedEnvCredential(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function readDedicatedKeychainCredential(account: string): Promise<string | undefined> {
  const testSecurityPath = process.env.ZAI_QUOTA_TEST_SECURITY_PATH;
  if (
    process.env.ZAI_QUOTA_TEST_DISABLE_KEYCHAIN === "1" ||
    (process.platform !== "darwin" && !testSecurityPath)
  ) return undefined;

  return new Promise((resolve) => {
    const child = spawn(
      testSecurityPath || "/usr/bin/security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
      { shell: false, stdio: ["ignore", "pipe", "ignore"] },
    );
    let output = Buffer.alloc(0);
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(undefined);
    }, 5_000);

    child.stdout?.on("data", (chunk) => {
      if (settled) return;
      output = Buffer.concat([output, Buffer.from(chunk)]);
      if (output.length > KEYCHAIN_OUTPUT_LIMIT_BYTES) {
        output = Buffer.alloc(0);
        child.kill("SIGTERM");
        finish(undefined);
      }
    });
    child.once("error", () => finish(undefined));
    child.once("close", (code) => {
      const value = output.toString("utf8").trim();
      finish(code === 0 && value ? value : undefined);
    });
  });
}

async function resolveCredential(): Promise<{ key: string; source: "zai-coding-cn-env" | "baby-menu-keychain"; binding: string }> {
  const china = normalizedEnvCredential("ZAI_CODING_CN_API_KEY");
  if (china) return credentialRecord(china, "zai-coding-cn-env");

  const key = await readDedicatedKeychainCredential("zai-coding-cn");
  if (key) return credentialRecord(key, "baby-menu-keychain");

  throw new SafeQuotaFailure("authentication-required", "Z.ai quota credential is not configured");
}

function credentialRecord(key: string, source: "zai-coding-cn-env" | "baby-menu-keychain") {
  return {
    key,
    source,
    binding: createHmac("sha256", CACHE_BINDING_KEY).update(source).update("\0").update(key).digest("hex"),
  };
}

function normalizeIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_:-]{0,63}$/.test(value)) {
    throw malformed(`invalid-${field}`);
  }
  return value;
}

function normalizeQuotaValue(owner: Record<string, unknown>, field: string): number | string | undefined {
  if (!hasOwn(owner, field) || owner[field] === null || owner[field] === undefined) return undefined;
  const value = owner[field];
  if (typeof value === "number") {
    if (Number.isFinite(value) && value >= 0) return value;
    throw malformed(`invalid-${field}`);
  }
  if (
    typeof value === "string" &&
    value.length <= 64 &&
    /^\d+(?:\.\d+)?$/.test(value) &&
    Number.isFinite(Number(value))
  ) {
    return value;
  }
  throw malformed(`invalid-${field}`);
}

function normalizePercentage(owner: Record<string, unknown>): number | undefined {
  if (!hasOwn(owner, "percentage") || owner.percentage === null || owner.percentage === undefined) return undefined;
  const value = owner.percentage;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw malformed("invalid-percentage");
  }
  return value;
}

function normalizeReset(owner: Record<string, unknown>): { nextResetTime: string | number; resetAt: string } | undefined {
  if (!hasOwn(owner, "nextResetTime") || owner.nextResetTime === null || owner.nextResetTime === undefined) {
    return undefined;
  }
  const value = owner.nextResetTime;
  if (
    (typeof value !== "string" || !value || value.length > 128) &&
    (typeof value !== "number" || !Number.isFinite(value) || value < 1_000_000_000_000)
  ) {
    throw malformed("invalid-next-reset-time");
  }

  const parsed = typeof value === "number" ? value : Date.parse(value);
  const date = new Date(parsed);
  if (!Number.isFinite(parsed) || Number.isNaN(date.getTime())) throw malformed("invalid-next-reset-time");
  return { nextResetTime: value as string | number, resetAt: date.toISOString() };
}

function normalizeUsageDetails(owner: Record<string, unknown>): Array<{ modelCode?: string; usage?: number | string }> | undefined {
  if (!hasOwn(owner, "usageDetails") || owner.usageDetails === null || owner.usageDetails === undefined) {
    return undefined;
  }
  if (!Array.isArray(owner.usageDetails)) throw malformed("invalid-usage-details");

  return owner.usageDetails.map((value) => {
    if (!isRecord(value)) throw malformed("invalid-usage-detail");
    const detail: { modelCode?: string; usage?: number | string } = {};
    if (hasOwn(value, "modelCode") && value.modelCode !== null && value.modelCode !== undefined) {
      if (
        typeof value.modelCode !== "string" ||
        value.modelCode.length > 128 ||
        !/^[A-Za-z0-9._:/-]+$/.test(value.modelCode)
      ) {
        throw malformed("invalid-model-code");
      }
      detail.modelCode = value.modelCode;
    }
    const usage = normalizeQuotaValue(value, "usage");
    if (usage !== undefined) detail.usage = usage;
    return detail;
  });
}

function normalizeLimit(value: unknown) {
  if (!isRecord(value)) throw malformed("invalid-limit-record");
  const type = normalizeIdentifier(value.type, "type");
  if (typeof value.unit !== "number" || !Number.isInteger(value.unit) || value.unit < 0) {
    throw malformed("invalid-unit");
  }

  const percentage = normalizePercentage(value);
  const currentValue = normalizeQuotaValue(value, "currentValue");
  const usage = normalizeQuotaValue(value, "usage");
  const reset = normalizeReset(value);
  const usageDetails = normalizeUsageDetails(value);
  const window = {
    id: `${type}:${value.unit}`,
    ...(type === "CREDIT_LIMIT" && value.unit === 3 ? { label: "5-hour" as const } : {}),
    ...(type === "CREDIT_LIMIT" && value.unit === 6 ? { label: "Weekly" as const } : {}),
    type,
    unit: value.unit,
    ...(percentage === undefined ? {} : { percentage, percentRemaining: 100 - percentage }),
    ...(currentValue === undefined ? {} : { currentValue }),
    ...(usage === undefined ? {} : { usage }),
    ...(reset ?? {}),
    ...(usageDetails === undefined ? {} : { usageDetails }),
  };
  return window;
}

function normalizePayload(value: unknown, credentialSource: "zai-coding-cn-env" | "baby-menu-keychain", refreshedAt: string) {
  if (!isRecord(value) || !isRecord(value.data) || !Array.isArray(value.data.limits) || value.data.limits.length === 0) {
    throw malformed("missing-limits");
  }
  return {
    schemaVersion: 1 as const,
    source: SOURCE,
    endpoint: ENDPOINT,
    credentialSource,
    windows: value.data.limits.map(normalizeLimit),
    refreshedAt,
    stale: false,
  };
}

function malformed(reason: string) {
  return new SafeQuotaFailure(
    "malformed-response",
    "Z.ai returned an incompatible quota response",
    reason === "response-too-large" ? { diagnostic: "response-too-large" } : {},
  );
}

function parseRetryAt(value: string | null): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const seconds = Number(value);
  const timestamp = Number.isFinite(seconds) && seconds >= 0
    ? Date.now() + seconds * 1_000
    : Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function readWithAbort<T>(reader: ReadableStreamDefaultReader<T>, signal: AbortSignal): Promise<ReadableStreamReadResult<T>> {
  if (signal.aborted) {
    return Promise.reject(new SafeQuotaFailure("unavailable", "Z.ai quota could not be reached", {
      diagnostic: "timeout",
    }));
  }
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new SafeQuotaFailure("unavailable", "Z.ai quota could not be reached", {
      diagnostic: "timeout",
    }));
    signal.addEventListener("abort", aborted, { once: true });
    reader.read().then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

async function readBoundedBody(response: Response, signal: AbortSignal): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > RESPONSE_LIMIT_BYTES) {
    throw malformed("response-too-large");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await readWithAbort(reader, signal);
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_LIMIT_BYTES) {
        await reader.cancel();
        throw malformed("response-too-large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof SafeQuotaFailure) throw error;
    throw new SafeQuotaFailure("unavailable", "Z.ai quota could not be reached", {
      diagnostic: signal.aborted ? "timeout" : "network",
    });
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function requestQuota(credential: { key: string; source: "zai-coding-cn-env" | "baby-menu-keychain" }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: "GET",
        headers: { Authorization: `Bearer ${credential.key}` },
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      const timeout = controller.signal.aborted || (isRecord(error) && error.name === "AbortError");
      throw new SafeQuotaFailure("unavailable", "Z.ai quota could not be reached", {
        diagnostic: timeout ? "timeout" : "network",
      });
    }

    if (response.status === 401 || response.status === 403) {
      throw new SafeQuotaFailure("authentication-required", "Z.ai rejected the configured quota credential", {
        httpStatus: response.status,
      });
    }
    if (response.status === 429) {
      throw new SafeQuotaFailure("rate-limit", "Z.ai quota is temporarily rate limited", {
        httpStatus: 429,
        retryAt: parseRetryAt(response.headers.get("retry-after")),
      });
    }
    if (response.status >= 500) {
      throw new SafeQuotaFailure("service-error", "Z.ai quota service is temporarily unavailable", {
        httpStatus: response.status,
      });
    }
    if (!response.ok) {
      throw new SafeQuotaFailure("unavailable", "Z.ai quota source is unavailable", {
        httpStatus: response.status,
      });
    }

    const body = await readBoundedBody(response, controller.signal);
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw malformed("invalid-json");
    }
    return normalizePayload(payload, credential.source, new Date().toISOString());
  } finally {
    clearTimeout(timer);
  }
}

function safeFailure(error: unknown) {
  if (error instanceof SafeQuotaFailure) {
    return {
      status: error.status,
      message: error.message,
      ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
      ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
      ...(error.diagnostic === undefined ? {} : { diagnostic: error.diagnostic }),
    };
  }
  return {
    status: "unavailable",
    message: "Z.ai quota is unavailable",
  };
}

function cloneSnapshot(snapshot: any, stale: boolean) {
  return {
    ...snapshot,
    windows: snapshot.windows.map((window: any) => ({
      ...window,
      ...(window.usageDetails ? { usageDetails: window.usageDetails.map((detail: any) => ({ ...detail })) } : {}),
    })),
    stale,
  };
}

async function acquireQuota() {
  const checkedAt = () => new Date().toISOString();
  let credential: { key: string; source: "zai-coding-cn-env" | "baby-menu-keychain"; binding: string };
  try {
    credential = await resolveCredential();
  } catch (error) {
    return { ok: false, checkedAt: checkedAt(), ...safeFailure(error) };
  }

  try {
    const data = await requestQuota(credential);
    zaiQuotaLastGoodCache = cloneSnapshot(data, false);
    zaiQuotaLastGoodCredentialBinding = credential.binding;
    return { ok: true, status: "fresh", checkedAt: checkedAt(), data: cloneSnapshot(data, false) };
  } catch (error) {
    const failure = safeFailure(error);
    if (
      STALE_ELIGIBLE_STATUSES.has(failure.status) &&
      zaiQuotaLastGoodCache &&
      zaiQuotaLastGoodCredentialBinding === credential.binding
    ) {
      return {
        ok: true,
        status: "stale",
        checkedAt: checkedAt(),
        data: cloneSnapshot(zaiQuotaLastGoodCache, true),
        warning: failure,
      };
    }
    return { ok: false, checkedAt: checkedAt(), ...failure };
  }
}

async function getQuota() {
  if (zaiQuotaInFlight) return zaiQuotaInFlight;
  zaiQuotaInFlight = acquireQuota().finally(() => {
    zaiQuotaInFlight = undefined;
  });
  return zaiQuotaInFlight;
}

export const actions = { getQuota };
