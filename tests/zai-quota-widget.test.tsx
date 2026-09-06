// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BabyMenuApi } from "../src/shared/contracts";
import {
  resetZaiQuotaStoreForTests,
  type ZaiQuotaFailure,
  type ZaiQuotaResult,
} from "./fixtures/zai-quota-generated/store";
import { zaiQuotaWidget } from "./fixtures/zai-quota-generated/widget";

const checkedAt = "2026-09-04T12:00:00.000Z";

function success(status: "fresh" | "stale" = "fresh", warning?: ZaiQuotaFailure): ZaiQuotaResult {
  return {
    ok: true,
    status,
    checkedAt,
    data: {
      schemaVersion: 1,
      source: "zai-quota-api",
      endpoint: "https://api.z.ai/api/monitor/usage/quota/limit",
      credentialSource: "zai-coding-cn-env",
      stale: status === "stale",
      refreshedAt: "2026-09-04T11:59:59.000Z",
      windows: [
        {
          id: "CREDIT_LIMIT:3",
          label: "5-hour",
          type: "CREDIT_LIMIT",
          unit: 3,
          percentage: 12.5,
          percentRemaining: 87.5,
          resetAt: "2026-09-04T15:30:00.000Z",
        },
        {
          id: "CREDIT_LIMIT:6",
          label: "Weekly",
          type: "CREDIT_LIMIT",
          unit: 6,
          percentage: 64,
          percentRemaining: 36,
        },
      ],
    },
    ...(warning ? { warning } : {}),
  };
}

function failure(status: ZaiQuotaFailure["status"]): ZaiQuotaResult {
  return {
    ok: false,
    status,
    checkedAt,
    message: "raw provider failure must not render",
  };
}

function installInvoke(invoke: BabyMenuApi["capabilities"]["invoke"]): void {
  window.babyMenu = {
    capabilities: { list: vi.fn(async () => []), invoke },
  } as unknown as BabyMenuApi;
}

describe("generated Z.ai quota widget", () => {
  beforeEach(() => {
    resetZaiQuotaStoreForTests();
  });

  afterEach(() => {
    cleanup();
    delete window.babyMenu;
    vi.restoreAllMocks();
  });

  it("starts in loading without a mount request, then renders both remaining-capacity windows", async () => {
    const invoke = vi.fn(async () => success()) as BabyMenuApi["capabilities"]["invoke"];
    installInvoke(invoke);

    render(zaiQuotaWidget.render());

    expect(screen.getByText("checking")).toBeTruthy();
    expect(screen.getByText("Z.AI · GLM")).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
    expect(zaiQuotaWidget.viewRefreshIntervalMs).toBe(600_000);

    await act(async () => {
      await zaiQuotaWidget.refreshView();
    });

    expect(invoke).toHaveBeenCalledWith("zai-quota", "getQuota");
    expect(screen.getByText("87.5")).toBeTruthy();
    expect(screen.getByText("36")).toBeTruthy();
    expect(screen.getByText("12.5% used")).toBeTruthy();
    expect(screen.getByText("64% used")).toBeTruthy();
    expect(screen.getByText("5-hour")).toBeTruthy();
    expect(screen.getByText("Weekly")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "5-hour remaining" }).getAttribute("aria-valuenow")).toBe("87.5");
    expect(screen.getByText("reset --")).toBeTruthy();
    expect(screen.getByText("fresh")).toBeTruthy();
  });

  it("keeps last-good values visible while updating and then marks a stale completion", async () => {
    let resolveSecond: (value: ZaiQuotaResult) => void = () => undefined;
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(success())
      .mockImplementationOnce(() => new Promise<ZaiQuotaResult>((resolve) => {
        resolveSecond = resolve;
      }));
    installInvoke(invoke as unknown as BabyMenuApi["capabilities"]["invoke"]);
    render(zaiQuotaWidget.render());

    await act(async () => {
      await zaiQuotaWidget.refreshView();
    });
    expect(screen.getByText("87.5")).toBeTruthy();

    let pending: void | Promise<void>;
    act(() => {
      pending = zaiQuotaWidget.refreshView();
    });
    await screen.findByText("updating");
    expect(screen.getByText("87.5")).toBeTruthy();
    expect(document.querySelector('[data-zai-state="fresh"]')).toBeTruthy();

    resolveSecond(success("stale", {
      status: "service-error",
      message: "safe static warning",
      httpStatus: 503,
    }));
    await act(async () => {
      await pending;
    });

    expect(screen.getByText("stale")).toBeTruthy();
    expect(screen.getByText("Z.ai quota service is unavailable")).toBeTruthy();
    expect(screen.getByText("87.5")).toBeTruthy();
    expect(document.querySelector('[data-zai-state="stale"]')).toBeTruthy();
  });

  it.each([
    ["authentication-required", "Z.ai quota needs a credential"],
    ["rate-limit", "Z.ai quota is rate limited"],
    ["service-error", "Z.ai quota service is unavailable"],
    ["malformed-response", "Z.ai quota format changed"],
    ["unavailable", "Z.ai quota is unavailable"],
  ] as const)("renders the %s state with safe specific copy", async (status, title) => {
    const invoke = vi.fn(async () => failure(status)) as BabyMenuApi["capabilities"]["invoke"];
    installInvoke(invoke);
    render(zaiQuotaWidget.render());

    await act(async () => {
      await zaiQuotaWidget.refreshView();
    });

    expect(screen.getByText(title)).toBeTruthy();
    expect(document.querySelector(`[data-zai-state="${status}"]`)).toBeTruthy();
    expect(screen.queryByText("raw provider failure must not render")).toBeNull();
    await waitFor(() => expect(screen.queryByText("checking")).toBeNull());
  });
});
