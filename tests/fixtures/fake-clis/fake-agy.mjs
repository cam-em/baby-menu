#!/usr/bin/env node
// Minimal fake of `agy --output-format stream-json --print=<prompt>`.
// Special SLOW_* prompts control deterministic cancellation tests.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse } from "yaml";

const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const argv = process.argv.slice(2);
const promptArg = argv.find((arg) => arg.startsWith("--print="));
const prompt = promptArg?.slice("--print=".length) ?? "";
const conversationArg = argv.find((arg) => arg.startsWith("--conversation="));
const resumed = Boolean(conversationArg);

if (process.env.FAKE_AGY_ARGS_FILE) writeFileSync(process.env.FAKE_AGY_ARGS_FILE, JSON.stringify(argv));
if (process.env.FAKE_AGY_CWD_FILE) writeFileSync(process.env.FAKE_AGY_CWD_FILE, process.cwd());
if (process.env.FAKE_AGY_ENV_FILE) {
  writeFileSync(process.env.FAKE_AGY_ENV_FILE, JSON.stringify({ hideAccountInfo: process.env.AGY_CLI_HIDE_ACCOUNT_INFO }));
}
if (process.env.FAKE_AGY_CLEAN_ROOM_FILE) {
  const agentIndex = argv.indexOf("--agent");
  const agentPath = agentIndex >= 0 ? argv[agentIndex + 1] : null;
  const agent = agentPath && existsSync(agentPath) ? readFileSync(agentPath, "utf8") : "";
  let cleanRoom = false;
  try {
    const frontmatter = agent.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    const config = frontmatter ? parse(frontmatter[1]) : null;
    cleanRoom = config?.inheritCustomizations === false && config?.inheritMcp === false;
  } catch {}
  writeFileSync(process.env.FAKE_AGY_CLEAN_ROOM_FILE, String(cleanRoom));
}

if (prompt.includes("PROVIDER_AUTH_ERROR")) {
  emit({
    event: "result",
    result: {
      conversation_id: "fake-conversation",
      status: "ERROR",
      error: "401 Unauthorized: private credential detail",
    },
  });
  process.exit(1);
}

if (prompt.includes("EXIT_NONZERO")) {
  process.stderr.write("private provider detail\n");
  process.exit(42);
}

if (prompt.includes("SLOW_CANCEL")) {
  const [, releaseFile = null, terminatedFile = null] = prompt.match(/SLOW_CANCEL:(\S+):(\S+)/) ?? [];
  let terminating = false;
  process.on("SIGTERM", () => {
    terminating = true;
    if (terminatedFile) writeFileSync(terminatedFile, "");
  });
  emit({ event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "ready" } });
  setInterval(() => {
    if (terminating && (!releaseFile || existsSync(releaseFile))) process.exit(0);
  }, 5);
  await new Promise(() => {});
}

if (prompt.includes("SLOW_FORCE_KILL")) {
  process.on("SIGTERM", () => {});
  emit({ event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "ready" } });
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}

emit({ event: "init", conversation_id: "fake-conversation", init: { cwd: process.cwd(), permission_mode: "always-proceed" } });
if (prompt.includes("RUN_TOOL")) {
  emit({
    event: "step_update",
    step_update: {
      conversation_id: "fake-conversation",
      step_index: 2,
      state: "ACTIVE",
      step_type: "tool",
      tool_name: "run_command",
      tool_info: { command: "private command", output: "private output" },
    },
  });
  emit({
    event: "step_update",
    step_update: {
      conversation_id: "fake-conversation",
      step_index: 2,
      state: "DONE",
      step_type: "tool",
      tool_name: "run_command",
      tool_info: { command: "private command", output: "private output" },
    },
  });
}
const reply = resumed ? `resumed:${prompt}` : `echo:${prompt}`;
emit({
  event: "step_update",
  step_update: {
    conversation_id: "fake-conversation",
    step_index: 3,
    state: "DONE",
    step_type: "agent_response",
    text_delta: reply,
  },
});
emit({ event: "result", result: { conversation_id: "fake-conversation", status: "SUCCESS", response: reply } });
