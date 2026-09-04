import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as schema from "@agentclientprotocol/sdk";
import { AdapterTurnError, type SessionDriver, type UpdateSink } from "../shared/types.js";
import { LineReader } from "../shared/line-reader.js";
import { logDebug } from "../shared/log.js";
import { childEnv } from "../shared/child-env.js";
import { mapAntigravityEvent, type AntigravityEvent } from "./mapper.js";

const SCOPE = "antigravity-adapter";
const TERMINATION_GRACE_MS = 1000;
const CLEAN_ROOM_AGENT = `---
name: baby-menu-clean-room
description: Clean-room coding agent for Baby Menu.
mainAgent: true
inheritCustomizations: false
inheritMcp: false
---
# Baby Menu clean-room agent

Follow the user's request using only built-in Antigravity capabilities and the instructions available in the active workspace.
`;

export type AntigravityDriverOptions = {
  /** Override the Antigravity binary (tests inject a fake). Defaults to `agy`. */
  command?: string;
};

/**
 * Drives one non-interactive Antigravity print process per turn. The initial
 * process creates a fresh Antigravity project rooted at the exact ACP cwd and
 * captures its conversation id. Later processes resume that conversation.
 *
 * `--dangerously-skip-permissions` is Antigravity's autonomous mode; the real
 * CLI reports it as `permission_mode: "always-proceed"`. A temporary agent
 * definition opts out of ambient user customizations and MCP servers, slash
 * expansion is disabled, and no extra directory is granted. Provider logging
 * is sent to `/dev/null`, and raw stderr/tool payloads never cross the adapter
 * boundary.
 */
export class AntigravityDriver implements SessionDriver {
  private readonly command: string;
  private cwd: string | null = null;
  private conversationId: string | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private activePrompt: Promise<schema.StopReason> | null = null;
  private activeCancel: (() => void) | null = null;

  constructor(options: AntigravityDriverOptions = {}) {
    this.command = options.command ?? "agy";
  }

  async start(cwd: string): Promise<void> {
    this.cwd = cwd;
  }

  async prompt(text: string, sink: UpdateSink, signal: AbortSignal): Promise<schema.StopReason> {
    const cwd = this.cwd;
    if (!cwd) throw new Error("Antigravity session not started");
    if (this.child) throw new Error("a prompt is already in progress");

    const agentDirectory = await mkdtemp(join(tmpdir(), "baby-menu-antigravity-"));
    const agentPath = join(agentDirectory, "agent.md");

    try {
      await writeFile(agentPath, CLEAN_ROOM_AGENT, { mode: 0o600 });
      const common = [
        "--output-format",
        "stream-json",
        "--dangerously-skip-permissions",
        "--disable-slash-commands",
        "--agent",
        agentPath,
        "--log-file",
        "/dev/null",
      ];
      const args = [
        ...common,
        ...(this.conversationId ? [`--conversation=${this.conversationId}`] : ["--new-project"]),
        `--print=${text}`,
      ];

      logDebug(SCOPE, "spawn", this.command, this.conversationId ? "(continue)" : "(new)");
      const env = childEnv();
      env.AGY_CLI_HIDE_ACCOUNT_INFO = "1";
      const child = spawn(this.command, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env });
      this.child = child;
      child.stdin.end();
      const reader = new LineReader();

      const activePrompt = new Promise<schema.StopReason>((resolve, reject) => {
        let settled = false;
        let stopReason: schema.StopReason | null = null;
        let terminalError: AdapterTurnError | null = null;
        let cancelled = false;
        let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

        const cleanup = () => {
          if (forceKillTimer) clearTimeout(forceKillTimer);
          this.child = null;
          this.activePrompt = null;
          this.activeCancel = null;
          signal.removeEventListener("abort", onAbort);
        };
        const settle = (reason: schema.StopReason) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(reason);
        };
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };
        const onAbort = () => {
          if (settled || cancelled) return;
          cancelled = true;
          logDebug(SCOPE, "cancel: terminating agy");
          child.kill("SIGTERM");
          forceKillTimer = setTimeout(() => child.kill("SIGKILL"), TERMINATION_GRACE_MS);
        };
        this.activeCancel = onAbort;

        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          for (const line of reader.push(chunk)) {
            let event: AntigravityEvent;
            try {
              event = JSON.parse(line) as AntigravityEvent;
            } catch {
              logDebug(SCOPE, "ignored non-json stdout bytes", Buffer.byteLength(line));
              continue;
            }
            const conversationId =
              event.conversation_id ?? event.step_update?.conversation_id ?? event.result?.conversation_id;
            if (conversationId) this.conversationId = conversationId;
            const result = mapAntigravityEvent(event);
            for (const update of result.updates) sink(update);
            if (result.terminalError) terminalError = result.terminalError;
            if (result.stopReason) {
              stopReason = result.stopReason;
              if (result.stopReason === "end_turn") terminalError = null;
            }
          }
        });
        child.stderr.on("data", (chunk: Buffer) => {
          logDebug(SCOPE, "stderr bytes", chunk.byteLength);
        });
        child.on("error", () => {
          if (cancelled) settle("cancelled");
          else {
            fail(
              new AdapterTurnError(
                "CLI_START_FAILED",
                "Antigravity CLI could not be started. Install `agy`, then restart Baby Menu.",
              ),
            );
          }
        });
        child.on("close", (code) => {
          logDebug(SCOPE, "agy exited", code);
          if (cancelled) {
            settle("cancelled");
            return;
          }
          if (terminalError) {
            fail(terminalError);
            return;
          }
          if (code !== 0) {
            fail(new AdapterTurnError("CLI_EXIT_FAILED", "Gemini via Antigravity stopped unexpectedly. Try again."));
            return;
          }
          settle(stopReason ?? "end_turn");
        });
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
      this.activePrompt = activePrompt;
      return await activePrompt;
    } finally {
      await rm(agentDirectory, { recursive: true, force: true });
    }
  }

  async dispose(): Promise<void> {
    const activePrompt = this.activePrompt;
    const activeCancel = this.activeCancel;
    if (activePrompt && activeCancel) {
      activeCancel();
      await activePrompt.catch(() => undefined);
      return;
    }
    this.child?.kill("SIGTERM");
  }
}
