import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExtensionDatabase, type ExtensionDatabase } from "../src/main/extension-database";
import { compileExtensionModule } from "../src/main/extension-module-compiler";
import { createServerActionRegistry, type ServerActionRegistry } from "../src/main/server-action-registry";

type SafeQuotaValue = number | string;

type ZaiUsageDetail = {
  modelCode?: string;
  usage?: SafeQuotaValue;
};

type ZaiQuotaWindow = {
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
  usageDetails?: ZaiUsageDetail[];
};

type ZaiQuotaFailure = {
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

type ZaiQuotaSnapshot = {
  schemaVersion: 1;
  source: "zai-quota-api";
  endpoint: "https://api.z.ai/api/monitor/usage/quota/limit";
  credentialSource: "zai-coding-cn-env" | "baby-menu-keychain";
  windows: ZaiQuotaWindow[];
  refreshedAt: string;
  stale: boolean;
};

type ZaiQuotaResult =
  | {
      ok: true;
      status: "fresh" | "stale";
      checkedAt: string;
      data: ZaiQuotaSnapshot;
      warning?: ZaiQuotaFailure;
    }
  | ({ ok: false; checkedAt: string } & ZaiQuotaFailure);

type InstalledFixture = {
  rootDir: string;
  database: ExtensionDatabase;
  registry: ServerActionRegistry;
};

const serverFixtureUrl = new URL("./fixtures/zai-quota-generated/server.ts.fixture", import.meta.url);
const widgetFixtureUrl = new URL("./fixtures/zai-quota-generated/widget.tsx", import.meta.url);
const componentsFixtureUrl = new URL("./fixtures/zai-quota-generated/components.tsx", import.meta.url);
const storeFixtureUrl = new URL("./fixtures/zai-quota-generated/store.ts", import.meta.url);
const originalEnv = { ...process.env };

function quotaResponse(limits: unknown[], options: { status?: number; headers?: HeadersInit; extras?: object } = {}): Response {
  return new Response(JSON.stringify({
    success: true,
    data: { limits, providerPrivateMarker: "raw-provider-private" },
    ...options.extras,
  }), {
    status: options.status ?? 200,
    headers: { "content-type": "application/json", ...options.headers },
  });
}

function validLimits(): unknown[] {
  return [
    {
      type: "CREDIT_LIMIT",
      unit: 3,
      percentage: 12.5,
      currentValue: 125,
      usage: 1_000,
      nextResetTime: "2026-09-04T15:30:00Z",
      usageDetails: [
        { modelCode: "glm-5", usage: 80, providerPrivateMarker: "raw-detail-private" },
        { modelCode: "glm-4.7", usage: "45" },
      ],
      accountEmail: "private@example.invalid",
    },
    {
      type: "CREDIT_LIMIT",
      unit: 6,
      percentage: 64,
      currentValue: "640",
      usage: "1000",
      nextResetTime: Date.parse("2026-09-11T00:00:00Z"),
    },
  ];
}

describe("clean generated Z.ai quota installation", () => {
  const tempDirs: string[] = [];
  const databases: ExtensionDatabase[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
    for (const key of [
      "ZAI_CODING_CN_API_KEY",
      "ZAI_QUOTA_TEST_DISABLE_KEYCHAIN",
      "ZAI_QUOTA_TEST_SECURITY_PATH",
      "ZAI_QUOTA_TEST_TIMEOUT_MS",
    ]) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    for (const database of databases.splice(0)) database.close();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function install(options: { credential?: string } = { credential: "fixture-secret" }): Promise<InstalledFixture> {
    const rootDir = await mkdtemp(join(tmpdir(), "baby-menu-zai-generated-"));
    tempDirs.push(rootDir);
    const extensionDir = join(rootDir, "extensions", "zai-quota");
    await mkdir(extensionDir, { recursive: true });
    await Promise.all([
      copyFile(serverFixtureUrl, join(extensionDir, "server.ts")),
      copyFile(widgetFixtureUrl, join(extensionDir, "widget.tsx")),
      copyFile(componentsFixtureUrl, join(extensionDir, "components.tsx")),
      copyFile(storeFixtureUrl, join(extensionDir, "store.ts")),
    ]);

    if (options.credential === undefined) delete process.env.ZAI_CODING_CN_API_KEY;
    else process.env.ZAI_CODING_CN_API_KEY = options.credential;
    process.env.ZAI_QUOTA_TEST_DISABLE_KEYCHAIN = "1";

    const database = createExtensionDatabase(join(rootDir, "baby-menu.db"));
    databases.push(database);
    const registry = createServerActionRegistry({
      rootDir,
      cacheDir: join(rootDir, "cache", "server-actions"),
      db: database,
    });
    return { rootDir, database, registry };
  }

  async function invoke(installed: InstalledFixture): Promise<ZaiQuotaResult> {
    return (await installed.registry.invoke("zai-quota", "getQuota")) as ZaiQuotaResult;
  }

  it("compiles the complete widget graph through the packaged extension compiler", async () => {
    const installed = await install();
    const extensionDir = join(installed.rootDir, "extensions", "zai-quota");

    const compiled = await compileExtensionModule({
      kind: "widget",
      extensionId: "zai-quota",
      extensionDir,
      entryFile: join(extensionDir, "widget.tsx"),
      cacheRoot: join(installed.rootDir, "cache", "widgets"),
    });

    expect(compiled.sourceFiles.map((file) => basename(file)).sort()).toEqual([
      "components.tsx",
      "store.ts",
      "widget.tsx",
    ]);
    expect(compiled.outputPath).toBe(join(compiled.outputDir, "widget.mjs"));
  });

  it("uses the exact GET with only an authorization header and returns both confirmed windows", async () => {
    const installed = await install();
    const fetchMock = vi.fn<typeof fetch>(async () => quotaResponse(validLimits()));
    vi.stubGlobal("fetch", fetchMock);

    const result = await invoke(installed);

    expect(result).toMatchObject({
      ok: true,
      status: "fresh",
      data: {
        schemaVersion: 1,
        source: "zai-quota-api",
        endpoint: "https://api.z.ai/api/monitor/usage/quota/limit",
        credentialSource: "zai-coding-cn-env",
        stale: false,
        windows: [
          {
            id: "CREDIT_LIMIT:3",
            label: "5-hour",
            type: "CREDIT_LIMIT",
            unit: 3,
            percentage: 12.5,
            percentRemaining: 87.5,
            currentValue: 125,
            usage: 1_000,
            nextResetTime: "2026-09-04T15:30:00Z",
            resetAt: "2026-09-04T15:30:00.000Z",
            usageDetails: [
              { modelCode: "glm-5", usage: 80 },
              { modelCode: "glm-4.7", usage: "45" },
            ],
          },
          {
            id: "CREDIT_LIMIT:6",
            label: "Weekly",
            type: "CREDIT_LIMIT",
            unit: 6,
            percentage: 64,
            percentRemaining: 36,
            currentValue: "640",
            usage: "1000",
            nextResetTime: Date.parse("2026-09-11T00:00:00Z"),
            resetAt: "2026-09-11T00:00:00.000Z",
          },
        ],
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init).toMatchObject({ method: "GET", redirect: "error" });
    expect(init?.body).toBeUndefined();
    expect(init?.headers).toEqual({ Authorization: "Bearer fixture-secret" });
  });

  it("preserves absent optional fields without inventing zero, reset, or a window label", async () => {
    const installed = await install();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => quotaResponse([
      { type: "CREDIT_LIMIT", unit: 3 },
      { type: "OTHER_LIMIT", unit: 6, currentValue: 4 },
    ])));

    const result = await invoke(installed);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.windows).toEqual([
      { id: "CREDIT_LIMIT:3", label: "5-hour", type: "CREDIT_LIMIT", unit: 3 },
      { id: "OTHER_LIMIT:6", type: "OTHER_LIMIT", unit: 6, currentValue: 4 },
    ]);
    expect(result.data.windows[0]).not.toHaveProperty("percentage");
    expect(result.data.windows[0]).not.toHaveProperty("percentRemaining");
    expect(result.data.windows[0]).not.toHaveProperty("resetAt");
  });

  it.each([
    ["missing data", { success: true }],
    ["non-array limits", { data: { limits: {} } }],
    ["empty limits", { data: { limits: [] } }],
    ["non-object record", { data: { limits: [null] } }],
    ["missing provider type", { data: { limits: [{ unit: 3, percentage: 10 }] } }],
    ["invalid provider unit", { data: { limits: [{ type: "CREDIT_LIMIT", unit: "3", percentage: 10 }] } }],
    ["invalid percentage", { data: { limits: [{ type: "CREDIT_LIMIT", unit: 3, percentage: "10" }] } }],
    ["out-of-range percentage", { data: { limits: [{ type: "CREDIT_LIMIT", unit: 3, percentage: 101 }] } }],
    ["invalid reset", { data: { limits: [{ type: "CREDIT_LIMIT", unit: 3, nextResetTime: "not-a-date" }] } }],
    ["epoch-second reset", { data: { limits: [{ type: "CREDIT_LIMIT", unit: 3, nextResetTime: 1_788_739_200 }] } }],
    ["invalid usage details", { data: { limits: [{ type: "CREDIT_LIMIT", unit: 3, usageDetails: {} }] } }],
  ])("returns malformed-response for %s", async (_label, payload) => {
    const installed = await install();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload), { status: 200 })));

    const result = await invoke(installed);

    expect(result).toMatchObject({ ok: false, status: "malformed-response" });
    expect(result).not.toHaveProperty("data");
  });

  it("returns authentication-required without network access when no explicit credential exists", async () => {
    const installed = await install({ credential: undefined });
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const result = await invoke(installed);

    expect(result).toMatchObject({
      ok: false,
      status: "authentication-required",
      message: "Z.ai quota credential is not configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads only the dedicated Baby Menu Keychain item when the operator chooses that explicit source", async () => {
    const installed = await install({ credential: undefined });
    const securityPath = join(installed.rootDir, "security-fixture.sh");
    await writeFile(securityPath, `#!/bin/sh
case "$*" in
  *"com.kunchenguid.baby-menu.zai-quota"*"zai-coding-cn"*) printf %s keychain-fixture-secret ;;
  *) exit 44 ;;
esac
`);
    await chmod(securityPath, 0o755);
    delete process.env.ZAI_QUOTA_TEST_DISABLE_KEYCHAIN;
    process.env.ZAI_QUOTA_TEST_SECURITY_PATH = securityPath;
    const fetchMock = vi.fn<typeof fetch>(async () => quotaResponse(validLimits()));
    vi.stubGlobal("fetch", fetchMock);

    const result = await invoke(installed);

    expect(result).toMatchObject({
      ok: true,
      status: "fresh",
      data: { credentialSource: "baby-menu-keychain" },
    });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
      Authorization: "Bearer keychain-fixture-secret",
    });
    expect(JSON.stringify(result)).not.toContain("keychain-fixture-secret");
  });

  it.each([401, 403])("classifies HTTP %i as authentication-required and does not serve stale quota", async (status) => {
    const installed = await install();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(quotaResponse(validLimits()))
      .mockResolvedValueOnce(new Response("rejected raw provider body", { status }));
    vi.stubGlobal("fetch", fetchMock);

    expect((await invoke(installed)).ok).toBe(true);
    const result = await invoke(installed);

    expect(result).toMatchObject({ ok: false, status: "authentication-required", httpStatus: status });
    expect(result).not.toHaveProperty("data");
    expect(JSON.stringify(result)).not.toContain("rejected raw provider body");
  });

  it("classifies rate limits and parses a safe retry timestamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T12:00:00Z"));
    const installed = await install();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response("raw rate detail", {
      status: 429,
      headers: { "retry-after": "120" },
    })));

    const result = await invoke(installed);

    expect(result).toMatchObject({
      ok: false,
      status: "rate-limit",
      httpStatus: 429,
      retryAt: "2026-09-04T12:02:00.000Z",
    });
    expect(JSON.stringify(result)).not.toContain("raw rate detail");
    vi.useRealTimers();
  });

  it.each([
    [500, "service-error"],
    [503, "service-error"],
    [404, "unavailable"],
    [418, "unavailable"],
  ] as const)("classifies HTTP %i as %s", async (httpStatus, status) => {
    const installed = await install();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response("raw failure detail", { status: httpStatus })));

    const result = await invoke(installed);

    expect(result).toMatchObject({ ok: false, status, httpStatus });
    expect(JSON.stringify(result)).not.toContain("raw failure detail");
  });

  it("rejects invalid JSON and oversized provider bodies without exposing either body", async () => {
    const invalidJsonInstall = await install();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response("raw invalid json marker", { status: 200 })));

    const invalidJson = await invoke(invalidJsonInstall);
    expect(invalidJson).toMatchObject({ ok: false, status: "malformed-response" });
    expect(JSON.stringify(invalidJson)).not.toContain("raw invalid json marker");

    const oversizedInstall = await install();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response("not read", {
      status: 200,
      headers: { "content-length": String(65 * 1024) },
    })));

    const oversized = await invoke(oversizedInstall);
    expect(oversized).toMatchObject({
      ok: false,
      status: "malformed-response",
      diagnostic: "response-too-large",
    });
    expect(JSON.stringify(oversized)).not.toContain("not read");
  });

  it("turns the whole-request deadline into a safe unavailable state", async () => {
    const installed = await install();
    process.env.ZAI_QUOTA_TEST_TIMEOUT_MS = "20";
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("secret timeout detail"), {
        name: "AbortError",
      })), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await invoke(installed);

    expect(result).toMatchObject({ ok: false, status: "unavailable", diagnostic: "timeout" });
    expect(JSON.stringify(result)).not.toContain("secret timeout detail");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the deadline active while a successful response body is still streaming", async () => {
    const installed = await install();
    process.env.ZAI_QUOTA_TEST_TIMEOUT_MS = "20";
    const neverEndingBody = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(neverEndingBody, { status: 200 })));

    const result = await invoke(installed);

    expect(result).toMatchObject({ ok: false, status: "unavailable", diagnostic: "timeout" });
  });

  it("returns same-credential last-good quota as visibly stale for a transient service failure", async () => {
    const installed = await install();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(quotaResponse(validLimits()))
      .mockResolvedValueOnce(new Response("provider outage detail", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const fresh = await invoke(installed);
    const stale = await invoke(installed);

    expect(fresh.ok).toBe(true);
    expect(stale).toMatchObject({
      ok: true,
      status: "stale",
      data: { stale: true },
      warning: { status: "service-error", httpStatus: 503 },
    });
    if (!fresh.ok || !stale.ok) return;
    expect(stale.data.refreshedAt).toBe(fresh.data.refreshedAt);
    expect(stale.data.windows).toEqual(fresh.data.windows);
    expect(JSON.stringify(stale)).not.toContain("provider outage detail");
  });

  it("does not reuse last-good data after the explicit credential changes", async () => {
    const installed = await install();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(quotaResponse(validLimits()))
      .mockRejectedValueOnce(new Error("raw network and credential detail"));
    vi.stubGlobal("fetch", fetchMock);

    expect((await invoke(installed)).ok).toBe(true);
    process.env.ZAI_CODING_CN_API_KEY = "different-fixture-secret";
    const result = await invoke(installed);

    expect(result).toMatchObject({ ok: false, status: "unavailable", diagnostic: "network" });
    expect(result).not.toHaveProperty("data");
    expect(JSON.stringify(result)).not.toContain("raw network and credential detail");
  });

  it("keeps credentials, unknown account fields, and raw provider data out of results, logs, and durable storage", async () => {
    const installed = await install({ credential: "never-expose-this-secret" });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => quotaResponse(validLimits(), {
      extras: { rawResponseMarker: "raw-top-level-private" },
    })));

    const result = await invoke(installed);
    const serialized = JSON.stringify(result);
    const databaseRows = installed.database.query<{ name: string; sql: string }>(
      "SELECT name, sql FROM sqlite_master WHERE name LIKE 'zai_%'",
    );
    const logs = JSON.stringify([...log.mock.calls, ...warn.mock.calls, ...error.mock.calls]);

    expect(result.ok).toBe(true);
    expect(serialized).not.toContain("never-expose-this-secret");
    expect(serialized).not.toContain("private@example.invalid");
    expect(serialized).not.toContain("raw-provider-private");
    expect(serialized).not.toContain("raw-detail-private");
    expect(serialized).not.toContain("raw-top-level-private");
    expect(logs).not.toContain("never-expose-this-secret");
    expect(logs).not.toContain("raw-");
    expect(databaseRows).toEqual([]);
  });
});
