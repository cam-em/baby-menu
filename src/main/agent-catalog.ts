import { readFile } from "node:fs/promises";
import type { BabyMenuCustomAgentInput } from "../shared/contracts";

export type AgentDefinition = {
  /** acpx agent name and registry key. */
  name: string;
  /** Display name shown in settings. */
  label: string;
  /** CLI command probed with commandExists to decide availability. */
  command: string;
  /** Shown in settings when the agent is unavailable. */
  installHint?: string;
  /** When set, registered as an acpx registry override so a custom command launches this agent. */
  launchCommand?: string;
  /**
   * Built-in clean-room adapter that wraps this agent's CLI. When set, the host
   * injects a `launchCommand` pointing at the bundled adapter at runtime (the
   * path differs dev vs packaged), while availability still probes `command`
   * (the underlying CLI the adapter drives).
   */
  adapter?: "antigravity" | "codex";
};

export type AgentOption = {
  name: string;
  label: string;
  available: boolean;
  installHint?: string;
  custom?: boolean;
  command?: string;
};

export const DEFAULT_AGENTS: readonly AgentDefinition[] = [
  {
    name: "gemini",
    label: "Gemini",
    command: "agy",
    adapter: "antigravity",
    installHint: "Install the Antigravity CLI (`agy`), then restart Baby Menu.",
  },
  {
    name: "gpt",
    label: "GPT",
    command: "codex",
    adapter: "codex",
    installHint: "Install the Codex CLI (`codex`), then restart Baby Menu.",
  },
];

/** Names of the code-defined built-in agents; these are read-only in the UI. */
export const BUILT_IN_AGENT_NAMES: ReadonlySet<string> = new Set(DEFAULT_AGENTS.map((agent) => agent.name));

export function normalizeLegacyBuiltInAgentName(name: string): string {
  const normalized = name.trim();
  return normalized === "claude" ? "gemini" : normalized === "codex" ? "gpt" : normalized;
}

export function migrateCollidingCustomAgentNames(
  definitions: readonly AgentDefinition[],
  builtIns: readonly AgentDefinition[] = DEFAULT_AGENTS,
): { definitions: AgentDefinition[]; renamed: Record<string, string> } {
  const reserved = new Set(builtIns.map((agent) => agent.name.toLowerCase()));
  const occupied = new Set(definitions.map((agent) => agent.name.toLowerCase()));
  const renamed: Record<string, string> = {};
  const migrated = definitions.map((definition) => {
    if (!reserved.has(definition.name.toLowerCase())) return { ...definition };
    const base = `custom-${definition.name.toLowerCase()}`;
    let name = base;
    for (let suffix = 2; occupied.has(name.toLowerCase()) || reserved.has(name.toLowerCase()); suffix += 1) {
      name = `${base}-${suffix}`;
    }
    occupied.add(name.toLowerCase());
    renamed[definition.name] = name;
    return { ...definition, name };
  });
  return { definitions: migrated, renamed };
}

/** A custom agent id is a slug: starts alphanumeric, then letters/digits/._- */
const CUSTOM_AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Validates and normalizes a custom-agent form input. Throws an Error with a
 * user-facing message when invalid. `existingCustomNames` are the names of other
 * custom agents already configured (case-insensitive duplicate check); built-in
 * names are rejected separately with a clearer message.
 */
export function validateCustomAgentInput(
  input: BabyMenuCustomAgentInput,
  existingCustomNames: Iterable<string>,
): Required<Pick<BabyMenuCustomAgentInput, "name" | "command">> & { label: string } {
  const name = (input.name ?? "").trim();
  const command = (input.command ?? "").trim();
  const label = (input.label ?? "").trim() || name;

  if (!name) throw new Error("Enter a name for the agent.");
  if (!CUSTOM_AGENT_NAME_PATTERN.test(name)) {
    throw new Error("Name must start with a letter or number and use only letters, numbers, dot, dash, or underscore.");
  }
  if (BUILT_IN_AGENT_NAMES.has(name.toLowerCase())) {
    throw new Error(`"${name}" is a built-in agent name. Choose a different name.`);
  }
  const taken = new Set([...existingCustomNames].map((existing) => existing.toLowerCase()));
  if (taken.has(name.toLowerCase())) {
    throw new Error(`An agent named "${name}" already exists.`);
  }
  if (!command) throw new Error("Enter the launch command for the agent.");

  return { name, label, command };
}

/** Maps a (validated) custom-agent input to an AgentDefinition. The launch command
 * becomes the acpx registry override; `command` (availability probe) is unused for
 * customs (no adapter + launchCommand => always available) so it defaults to name. */
export function customAgentToDefinition(input: BabyMenuCustomAgentInput): AgentDefinition {
  const label = (input.label ?? "").trim() || input.name;
  return { name: input.name, label, command: input.name, launchCommand: input.command };
}

type ResolveAgentCatalogOptions = {
  /** Parsed contents of agents.json (an array of agent definitions). */
  config?: unknown;
  /** Built-in defaults; overridable for tests. */
  defaults?: readonly AgentDefinition[];
};

export function parseAgentDefinitions(config: unknown): AgentDefinition[] {
  if (!Array.isArray(config)) return [];
  const definitions: AgentDefinition[] = [];
  for (const entry of config) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as Record<string, unknown>;
    const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
    if (!name) continue;
    const command = typeof candidate.command === "string" ? candidate.command.trim() : "";
    const launchCommand = typeof candidate.launchCommand === "string" ? candidate.launchCommand.trim() : "";
    definitions.push({
      name,
      label: typeof candidate.label === "string" && candidate.label.trim() ? candidate.label.trim() : name,
      command: command || name,
      installHint: typeof candidate.installHint === "string" ? candidate.installHint : undefined,
      launchCommand: launchCommand || undefined,
    });
  }
  return definitions;
}

export function resolveAgentCatalog(options: ResolveAgentCatalogOptions = {}): AgentDefinition[] {
  const defaults = options.defaults ?? DEFAULT_AGENTS;
  const order = defaults.map((agent) => agent.name);
  const builtInNames = new Set(defaults.map((agent) => agent.name.toLowerCase()));
  const byName = new Map<string, AgentDefinition>(defaults.map((agent) => [agent.name, { ...agent }]));

  for (const definition of parseAgentDefinitions(options.config)) {
    // Built-ins are a product contract: Gemini always routes through agy and
    // GPT always routes through Codex. agents.json remains additive for custom
    // ACP agents but cannot silently redirect a built-in label.
    if (builtInNames.has(definition.name.toLowerCase())) continue;
    if (!byName.has(definition.name)) order.push(definition.name);
    byName.set(definition.name, definition);
  }

  return order.map((name) => byName.get(name)!);
}

/**
 * Injects the bundled adapter launchCommand for every built-in adapter agent.
 * `resolveAdapterPath("antigravity")` returns the absolute path to the adapter's
 * bundled entry; the host resolves it differently in dev vs packaged mode.
 * `launcher` is the command + leading args that run the adapter as a Node
 * program (e.g. `["node"]`, or `["env", "ELECTRON_RUN_AS_NODE=1", electronPath]`
 * to run the bundled Electron as Node without depending on a separate install).
 * Agents that already carry an explicit `launchCommand` (custom agents) are left
 * untouched.
 */
export function withAdapterLaunchCommands(
  catalog: readonly AgentDefinition[],
  resolveAdapterPath: (adapter: "antigravity" | "codex") => string,
  launcher: string[] = ["node"],
): AgentDefinition[] {
  return catalog.map((agent) => {
    if (!agent.adapter || agent.launchCommand) return { ...agent };
    const adapterPath = resolveAdapterPath(agent.adapter);
    return { ...agent, launchCommand: shellJoin([...launcher, adapterPath]) };
  });
}

/** Joins command tokens into a single string, quoting tokens with whitespace. */
function shellJoin(tokens: string[]): string {
  return tokens.map((token) => (/\s/.test(token) ? `"${token}"` : token)).join(" ");
}

export function toAgentOptions(
  catalog: readonly AgentDefinition[],
  commandExists: (command: string) => boolean,
): AgentOption[] {
  return catalog.map((agent) => {
    const custom = !BUILT_IN_AGENT_NAMES.has(agent.name.toLowerCase());
    return {
      name: agent.name,
      label: agent.label,
      available: agent.launchCommand && !agent.adapter ? true : commandExists(agent.command),
      installHint: agent.installHint,
      custom,
      // Only customs surface their launch command (so the edit form can prefill it).
      ...(custom && agent.launchCommand ? { command: agent.launchCommand } : {}),
    };
  });
}

export function agentRegistryOverrides(catalog: readonly AgentDefinition[]): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const agent of catalog) {
    if (agent.launchCommand) overrides[agent.name] = agent.launchCommand;
  }
  return overrides;
}

export async function loadAgentConfigFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}
