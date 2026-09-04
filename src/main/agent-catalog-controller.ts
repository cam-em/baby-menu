import type { BabyMenuCustomAgentInput } from "../shared/contracts";
import type { PreferencesService } from "./preferences";
import { writeJsonFile } from "./atomic-json-file";
import {
  type AgentDefinition,
  type AgentOption,
  agentRegistryOverrides,
  customAgentToDefinition,
  loadAgentConfigFile,
  migrateCollidingCustomAgentNames,
  parseAgentDefinitions,
  resolveAgentCatalog,
  toAgentOptions,
  validateCustomAgentInput,
  withAdapterLaunchCommands,
} from "./agent-catalog";

export const AGENT_CONFIGURATION_UNAVAILABLE = "Agent configuration is unavailable. Check agents.json and preferences.json for valid JSON and read/write permissions, then restart Baby Menu.";

export type AgentCatalogControllerOptions = {
  /** Path to the user-owned agents.json (repo root in dev, ~/.baby-menu packaged). */
  agentsJsonPath: string;
  resolveAdapterPath: (adapter: "antigravity" | "codex") => string;
  adapterLauncher: string[];
  commandExists: (command: string) => boolean;
  /** The currently selected agent name; removal of the active agent is refused. */
  getActiveAgentName: () => string;
  preferences?: Pick<PreferencesService, "migrateAgentSelection" | "completeAgentSelectionMigration">;
  /** Called whenever the registry overrides change so the runtime can pick them up live. */
  onOverridesChange?: (overrides: Record<string, string>) => void | Promise<void>;
};

export type AgentCatalogController = {
  /** Reads agents.json and builds the initial catalog. Returns the controller. */
  load: () => Promise<AgentCatalogController>;
  readonly catalog: readonly AgentDefinition[];
  readonly overrides: Record<string, string>;
  readonly unavailableReason: string | undefined;
  options: () => AgentOption[];
  addAgent: (input: BabyMenuCustomAgentInput) => Promise<void>;
  updateAgent: (name: string, input: { label?: string; command: string }) => Promise<void>;
  removeAgent: (name: string) => Promise<void>;
};

/**
 * Owns the live agent catalog: the code-defined built-ins plus the user's custom
 * ACP agents persisted in agents.json. Mutations validate, rewrite agents.json,
 * rebuild the catalog and acpx registry overrides, and notify via onOverridesChange
 * so a newly added/edited agent applies immediately (no app restart).
 */
export function createAgentCatalogController(options: AgentCatalogControllerOptions): AgentCatalogController {
  let customs: AgentDefinition[] = [];
  let catalog: AgentDefinition[] = [];
  let overrides: Record<string, string> = {};
  let unavailableReason: string | undefined = AGENT_CONFIGURATION_UNAVAILABLE;

  function assertAvailable(): void {
    if (unavailableReason) throw new Error(unavailableReason);
  }

  function rebuild(): void {
    catalog = withAdapterLaunchCommands(
      resolveAgentCatalog({ config: customs }),
      options.resolveAdapterPath,
      options.adapterLauncher,
    );
    overrides = agentRegistryOverrides(catalog);
  }

  async function persist(): Promise<void> {
    await writeJsonFile(options.agentsJsonPath, customs.map(serializeDefinition));
  }

  async function commit(next: AgentDefinition[]): Promise<void> {
    customs = next;
    await persist();
    rebuild();
    await options.onOverridesChange?.(overrides);
  }

  rebuild();

  const controller: AgentCatalogController = {
    async load() {
      try {
        const loaded = parseAgentDefinitions(await loadAgentConfigFile(options.agentsJsonPath));
        const migration = migrateCollidingCustomAgentNames(loaded);
        customs = migration.definitions;
        await options.preferences?.migrateAgentSelection(migration.renamed, loaded.map((agent) => agent.name));
        if (Object.keys(migration.renamed).length > 0) {
          await persist();
        }
        await options.preferences?.completeAgentSelectionMigration();
        rebuild();
        unavailableReason = undefined;
        return controller;
      } catch (error) {
        unavailableReason = AGENT_CONFIGURATION_UNAVAILABLE;
        throw error;
      }
    },
    get unavailableReason() {
      return unavailableReason;
    },
    get catalog() {
      return catalog;
    },
    get overrides() {
      return overrides;
    },
    options() {
      return toAgentOptions(catalog, options.commandExists).map((agent) => unavailableReason
        ? { ...agent, available: false, installHint: unavailableReason }
        : agent);
    },
    async addAgent(input) {
      assertAvailable();
      const validated = validateCustomAgentInput(input, customs.map((agent) => agent.name));
      await commit([...customs, customAgentToDefinition(validated)]);
    },
    async updateAgent(name, input) {
      assertAvailable();
      if (!customs.some((agent) => agent.name === name)) {
        throw new Error(`No custom agent named "${name}".`);
      }
      // Validate against the other customs so the unchanged id is allowed.
      const others = customs.filter((agent) => agent.name !== name).map((agent) => agent.name);
      const validated = validateCustomAgentInput({ name, label: input.label, command: input.command }, others);
      await commit(customs.map((agent) => (agent.name === name ? customAgentToDefinition(validated) : agent)));
    },
    async removeAgent(name) {
      assertAvailable();
      if (options.getActiveAgentName() === name) {
        throw new Error("This agent is active. Switch to another agent before removing it.");
      }
      await commit(customs.filter((agent) => agent.name !== name));
    },
  };

  return controller;
}

/** Serializes a custom AgentDefinition back to agents.json, dropping empty fields. */
function serializeDefinition(agent: AgentDefinition): Record<string, string> {
  const entry: Record<string, string> = { name: agent.name, label: agent.label, command: agent.command };
  if (agent.launchCommand) entry.launchCommand = agent.launchCommand;
  if (agent.registryCommand) entry.registryCommand = agent.registryCommand;
  if (agent.installHint) entry.installHint = agent.installHint;
  return entry;
}
