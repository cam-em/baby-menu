import { describe, expect, it } from "vitest";
import { mapAntigravityEvent } from "../src/adapters/antigravity/mapper";

describe("mapAntigravityEvent (agy stream-json)", () => {
  it("ignores init and user input events", () => {
    expect(mapAntigravityEvent({ event: "init", init: { permission_mode: "always-proceed" } }).updates).toEqual([]);
    expect(
      mapAntigravityEvent({
        event: "step_update",
        step_update: { step_index: 0, state: "DONE", step_type: "user_input" },
      }).updates,
    ).toEqual([]);
  });

  it("maps an agent response delta to an ACP assistant chunk", () => {
    expect(
      mapAntigravityEvent({
        event: "step_update",
        step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "Finished." },
      }).updates,
    ).toEqual([{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Finished." } }]);
  });

  it("maps tool lifecycle without forwarding raw provider input or output", () => {
    const active = mapAntigravityEvent({
      event: "step_update",
      step_update: {
        step_index: 2,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: { command: "private command", output: "private output" },
      },
    });
    const done = mapAntigravityEvent({
      event: "step_update",
      step_update: {
        step_index: 2,
        state: "DONE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: { command: "private command", output: "private output" },
      },
    });

    expect(active.updates).toEqual([
      {
        sessionUpdate: "tool_call",
        toolCallId: "agy-step-2",
        title: "running command",
        kind: "execute",
        status: "in_progress",
      },
    ]);
    expect(done.updates).toEqual([
      { sessionUpdate: "tool_call_update", toolCallId: "agy-step-2", status: "completed", content: [] },
    ]);
    expect(JSON.stringify([...active.updates, ...done.updates])).not.toMatch(/private command|private output/);
  });

  it("ends successful turns without re-emitting the final response", () => {
    const result = mapAntigravityEvent({
      event: "result",
      result: { status: "SUCCESS", response: "Already emitted" },
    });
    expect(result).toEqual({ updates: [], stopReason: "end_turn" });
  });

  it("classifies authentication failures with safe Antigravity guidance", () => {
    const result = mapAntigravityEvent({
      event: "result",
      result: { status: "ERROR", error: "401 Unauthorized: private credential detail" },
    });
    expect(result.terminalError).toMatchObject({
      code: "AUTHENTICATION_FAILED",
      message: "Gemini is not authenticated in Antigravity. Open Antigravity and sign in, then try again.",
    });
    expect(result.terminalError?.message).not.toContain("private credential detail");
  });
});
