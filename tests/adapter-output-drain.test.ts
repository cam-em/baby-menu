import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AntigravityDriver } from "../src/adapters/antigravity/driver";
import { CodexDriver } from "../src/adapters/codex/driver";
import type { SessionUpdate } from "@agentclientprotocol/sdk";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: vi.fn(),
}));

afterEach(() => vi.mocked(spawn).mockReset());

describe.each([
  {
    name: "Antigravity",
    create: () => new AntigravityDriver(),
    text: { event: "step_update", step_update: { step_type: "agent_response", text_delta: "final text" } },
    success: { event: "result", result: { status: "SUCCESS" } },
    error: { event: "result", result: { status: "ERROR", error: "unauthorized" } },
  },
  {
    name: "Codex",
    create: () => new CodexDriver(),
    text: { type: "item.completed", item: { type: "agent_message", text: "final text" } },
    success: { type: "turn.completed" },
    error: { type: "turn.failed", message: "unauthorized" },
  },
])("$name output drainage", ({ create, text, success, error }) => {
  it.each([false, true])("processes output after exit before settling (failure=%s)", async (failure) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true),
    });
    let spawned!: () => void;
    const ready = new Promise<void>((resolve) => { spawned = resolve; });
    vi.mocked(spawn).mockImplementation(() => {
      spawned();
      return child as unknown as ChildProcessWithoutNullStreams;
    });
    const driver = create();
    await driver.start(process.cwd());
    const updates: SessionUpdate[] = [];
    let settled = false;
    const outcome = driver.prompt("work", (update) => updates.push(update), new AbortController().signal)
      .then((reason) => { settled = true; return { reason, error: undefined }; },
        (error: unknown) => { settled = true; return { reason: undefined, error }; });
    await ready;
    child.emit("exit", 0, null);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    child.stdout.write(`${JSON.stringify(text)}\n${JSON.stringify(failure ? error : success)}\n`);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);
    const result = await outcome;
    expect(updates).toContainEqual({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "final text" } });
    if (failure) expect(result.error).toMatchObject({ code: "AUTHENTICATION_FAILED" });
    else expect(result).toEqual({ reason: "end_turn", error: undefined });
    await driver.dispose();
  });
});
