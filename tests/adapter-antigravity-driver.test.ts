import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { existsSync, watch } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { AntigravityDriver } from "../src/adapters/antigravity/driver";
import type * as schema from "@agentclientprotocol/sdk";

const FAKE = join(__dirname, "fixtures", "fake-clis", "fake-agy.mjs");

function waitForFile(path: string): Promise<void> {
  if (existsSync(path)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const watcher = watch(dirname(path), (_event, filename) => {
      if (filename === basename(path) && existsSync(path)) {
        watcher.close();
        resolve();
      }
    });
    watcher.on("error", (error) => {
      watcher.close();
      reject(error);
    });
  });
}

async function slowCancelGate(): Promise<{ prompt: string; terminated: Promise<void>; release: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "antigravity-driver-"));
  const sentinel = join(dir, "release-exit");
  const terminated = join(dir, "observed-sigterm");
  return { prompt: `SLOW_CANCEL:${sentinel}:${terminated}`, terminated: waitForFile(terminated), release: () => writeFile(sentinel, "") };
}

describe("AntigravityDriver (against a fake agy CLI)", () => {
  let driver: AntigravityDriver | null = null;
  afterEach(async () => {
    await driver?.dispose();
    driver = null;
  });

  function makeDriver(command = FAKE): AntigravityDriver {
    driver = new AntigravityDriver({ command });
    return driver;
  }

  it("streams an assistant chunk and resolves end_turn", async () => {
    const d = makeDriver();
    await d.start(tmpdir());
    const updates: schema.SessionUpdate[] = [];
    expect(await d.prompt("hello", (update) => updates.push(update), new AbortController().signal)).toBe("end_turn");
    expect(updates.find((update) => update.sessionUpdate === "agent_message_chunk")).toMatchObject({
      content: { type: "text", text: "echo:hello" },
    });
  });

  it("starts a clean project in the exact ACP workspace with verified autonomous permissions", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "antigravity-workspace-"));
    const evidence = await mkdtemp(join(tmpdir(), "antigravity-evidence-"));
    const argsFile = join(evidence, "args.json");
    const cwdFile = join(evidence, "cwd.txt");
    const envFile = join(evidence, "env.json");
    const cleanRoomFile = join(evidence, "clean-room.txt");
    process.env.FAKE_AGY_ARGS_FILE = argsFile;
    process.env.FAKE_AGY_CWD_FILE = cwdFile;
    process.env.FAKE_AGY_ENV_FILE = envFile;
    process.env.FAKE_AGY_CLEAN_ROOM_FILE = cleanRoomFile;
    try {
      const d = makeDriver();
      await d.start(workspace);
      await d.prompt("work", () => {}, new AbortController().signal);
      const args = JSON.parse(await readFile(argsFile, "utf8")) as string[];
      expect(await realpath(await readFile(cwdFile, "utf8"))).toBe(await realpath(workspace));
      expect(args).toContain("--output-format");
      expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
      expect(args).toContain("--dangerously-skip-permissions");
      expect(args).toContain("--disable-slash-commands");
      expect(args).toContain("--agent");
      expect(await readFile(cleanRoomFile, "utf8")).toBe("true");
      expect(existsSync(args[args.indexOf("--agent") + 1])).toBe(false);
      expect(args).toContain("--new-project");
      expect(args).toContain("--log-file");
      expect(args[args.indexOf("--log-file") + 1]).toBe("/dev/null");
      expect(args).toContain("--print=work");
      expect(args).not.toContain("--add-dir");
      expect(JSON.parse(await readFile(envFile, "utf8"))).toEqual({ hideAccountInfo: "1" });
    } finally {
      delete process.env.FAKE_AGY_ARGS_FILE;
      delete process.env.FAKE_AGY_CWD_FILE;
      delete process.env.FAKE_AGY_ENV_FILE;
      delete process.env.FAKE_AGY_CLEAN_ROOM_FILE;
    }
  });

  it("continues the captured Antigravity conversation on later turns", async () => {
    const evidence = await mkdtemp(join(tmpdir(), "antigravity-evidence-"));
    const argsFile = join(evidence, "args.json");
    process.env.FAKE_AGY_ARGS_FILE = argsFile;
    try {
      const d = makeDriver();
      await d.start(tmpdir());
      await d.prompt("first", () => {}, new AbortController().signal);
      const updates: schema.SessionUpdate[] = [];
      await d.prompt("second", (update) => updates.push(update), new AbortController().signal);
      const args = JSON.parse(await readFile(argsFile, "utf8")) as string[];
      expect(args).toContain("--conversation=fake-conversation");
      expect(args).not.toContain("--new-project");
      expect(updates.find((update) => update.sessionUpdate === "agent_message_chunk")).toMatchObject({
        content: { type: "text", text: "resumed:second" },
      });
    } finally {
      delete process.env.FAKE_AGY_ARGS_FILE;
    }
  });

  it("returns safe actionable authentication and unavailable-command failures", async () => {
    const d = makeDriver();
    await d.start(tmpdir());
    await expect(d.prompt("PROVIDER_AUTH_ERROR", () => {}, new AbortController().signal)).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
      message: "Gemini is not authenticated in Antigravity. Open Antigravity and sign in, then try again.",
    });

    await d.dispose();
    driver = null;
    const missing = makeDriver(join(tmpdir(), "missing-agy-command"));
    await missing.start(tmpdir());
    await expect(missing.prompt("hello", () => {}, new AbortController().signal)).rejects.toMatchObject({
      code: "CLI_START_FAILED",
      message: "Antigravity CLI could not be started. Install `agy`, then restart Baby Menu.",
    });
  });

  it("does not expose stderr when agy exits unexpectedly", async () => {
    const d = makeDriver();
    await d.start(tmpdir());
    const prompt = d.prompt("EXIT_NONZERO", () => {}, new AbortController().signal);
    await expect(prompt).rejects.toMatchObject({ code: "CLI_EXIT_FAILED" });
    await expect(prompt).rejects.not.toThrow(/private provider detail/);
  });

  it("surfaces sanitized tool lifecycle updates", async () => {
    const d = makeDriver();
    await d.start(tmpdir());
    const updates: schema.SessionUpdate[] = [];
    await d.prompt("RUN_TOOL", (update) => updates.push(update), new AbortController().signal);
    expect(updates.some((update) => update.sessionUpdate === "tool_call")).toBe(true);
    expect(updates.some((update) => update.sessionUpdate === "tool_call_update")).toBe(true);
    expect(JSON.stringify(updates)).not.toMatch(/private command|private output/);
  });

  it("resolves cancelled when the signal is already aborted", async () => {
    const d = makeDriver();
    await d.start(tmpdir());
    const controller = new AbortController();
    controller.abort();
    await expect(d.prompt("hello", () => {}, controller.signal)).resolves.toBe("cancelled");
  });

  it("waits for the child process to exit before resolving cancellation", async () => {
    const d = makeDriver();
    await d.start(tmpdir());
    const gate = await slowCancelGate();
    const controller = new AbortController();
    let ready!: () => void;
    const readyPromise = new Promise<void>((resolve) => { ready = resolve; });
    const prompt = d.prompt(gate.prompt, (update) => {
      if (update.sessionUpdate === "agent_message_chunk") ready();
    }, controller.signal);
    await readyPromise;
    let settled = false;
    void prompt.then(() => { settled = true; });
    controller.abort();
    await gate.terminated;
    await Promise.resolve();
    expect(settled).toBe(false);
    await gate.release();
    await expect(prompt).resolves.toBe("cancelled");
  });

  it("force-kills a child that outlives the termination grace period", async () => {
    const d = makeDriver();
    await d.start(tmpdir());
    let ready!: () => void;
    const readyPromise = new Promise<void>((resolve) => { ready = resolve; });
    const prompt = d.prompt("SLOW_FORCE_KILL", (update) => {
      if (update.sessionUpdate === "agent_message_chunk") ready();
    }, new AbortController().signal);
    await readyPromise;
    await d.dispose();
    await expect(prompt).resolves.toBe("cancelled");
  });
});
