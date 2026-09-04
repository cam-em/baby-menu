import type * as schema from "@agentclientprotocol/sdk";
import { providerTurnError, type MapResult } from "../shared/types.js";

/**
 * Structured events emitted by `agy --output-format stream-json`.
 * Only assistant text and sanitized tool lifecycle metadata cross into ACP.
 * Provider tool input/output and result payloads are intentionally discarded.
 */
export type AntigravityEvent = {
  event?: string;
  conversation_id?: string;
  init?: {
    cwd?: string;
    permission_mode?: string;
  };
  step_update?: {
    conversation_id?: string;
    step_index?: number;
    state?: string;
    step_type?: string;
    text_delta?: string;
    tool_name?: string;
    tool_info?: unknown;
  };
  result?: {
    conversation_id?: string;
    status?: string;
    response?: string;
    error?: string;
  };
};

const EMPTY: MapResult = { updates: [] };

export function mapAntigravityEvent(event: AntigravityEvent): MapResult {
  if (event.event === "step_update") return mapStep(event.step_update);
  if (event.event !== "result") return EMPTY;

  if (event.result?.status === "SUCCESS") {
    return { updates: [], stopReason: "end_turn" };
  }
  return {
    updates: [],
    terminalError: providerTurnError("Gemini", event.result?.error),
  };
}

function mapStep(step: AntigravityEvent["step_update"]): MapResult {
  if (!step) return EMPTY;
  if (step.step_type === "agent_response" && step.text_delta) {
    return {
      updates: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: step.text_delta } }],
    };
  }
  if (step.step_type !== "tool" || typeof step.step_index !== "number") return EMPTY;

  const toolCallId = `agy-step-${step.step_index}`;
  if (step.state === "ACTIVE") {
    const { kind, title } = safeToolPresentation(step.tool_name);
    return {
      updates: [{ sessionUpdate: "tool_call", toolCallId, title, kind, status: "in_progress" }],
    };
  }
  return {
    updates: [
      {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: step.state === "ERROR" || step.state === "FAILED" ? "failed" : "completed",
        content: [],
      },
    ],
  };
}

function safeToolPresentation(name: string | undefined): { kind: schema.ToolKind; title: string } {
  const normalized = name?.toLowerCase() ?? "";
  if (/command|shell|terminal/.test(normalized)) return { kind: "execute", title: "running command" };
  if (/edit|write|create|delete|move|rename/.test(normalized)) return { kind: "edit", title: "editing extension" };
  if (/read|view/.test(normalized)) return { kind: "read", title: "reading workspace" };
  if (/search|grep|find|glob/.test(normalized)) return { kind: "search", title: "searching workspace" };
  if (/web|fetch|browser/.test(normalized)) return { kind: "fetch", title: "checking source" };
  return { kind: "other", title: "working" };
}
