import { describe, expect, it } from "vitest";
import {
  BUILT_IN_AGENT_NAMES,
  DEFAULT_AGENTS,
  customAgentToDefinition,
  resolveAgentCatalog,
  toAgentOptions,
  agentRegistryOverrides,
  validateCustomAgentInput,
  withAdapterLaunchCommands,
  loadAgentConfigFile,
  parseAgentDefinitions,
  migrateCollidingCustomAgentNames,
} from "../src/main/agent-catalog";

describe("agent-catalog", () => {
  it("ships Gemini and GPT as the built-in agents", () => {
    expect(DEFAULT_AGENTS.map((agent) => agent.name)).toEqual(["gemini", "gpt"]);
    expect(DEFAULT_AGENTS.map((agent) => agent.label)).toEqual(["Gemini", "GPT"]);
    expect(DEFAULT_AGENTS.map((agent) => agent.command)).toEqual(["agy", "codex"]);
    expect(DEFAULT_AGENTS.map((agent) => agent.adapter)).toEqual(["antigravity", "codex"]);
  });

  it("derives Settings availability by probing each agent's wrapped CLI", () => {
    const available = (commands: string[]) => {
      const set = new Set(commands);
      return (command: string) => set.has(command);
    };
    const options = toAgentOptions(DEFAULT_AGENTS, available(["agy"]));
    const byName = Object.fromEntries(options.map((o) => [o.name, o.available]));
    expect(byName).toEqual({ gemini: true, gpt: false });
  });

  it("keeps built-ins immutable while appending custom agents.json entries", () => {
    const catalog = resolveAgentCatalog({
      config: [
        { name: "gemini", label: "Override", launchCommand: "other-acp" },
        { name: "rovo", command: "rovo" },
      ],
    });
    const gemini = catalog.find((agent) => agent.name === "gemini");
    expect(gemini).toMatchObject({ label: "Gemini", command: "agy", adapter: "antigravity" });
    expect(gemini?.launchCommand).toBeUndefined();
    expect(catalog.find((agent) => agent.name === "rovo")?.command).toBe("rovo");
  });

  it("parseAgentDefinitions normalizes entries and defaults command to name", () => {
    const defs = parseAgentDefinitions([{ name: "pi", launchCommand: "npx pi-acp" }, { bad: true }]);
    expect(defs).toEqual([{ name: "pi", label: "pi", command: "pi", installHint: undefined, launchCommand: "npx pi-acp" }]);
  });

  it("deterministically migrates custom ids that became built-in names", () => {
    const migration = migrateCollidingCustomAgentNames([
      { name: "gemini", label: "Old Gemini", command: "gemini", launchCommand: "gemini-acp" },
      { name: "custom-gemini", label: "Existing", command: "existing" },
      { name: "gpt", label: "Old GPT", command: "gpt-acp", launchCommand: "gpt-acp" },
    ]);
    expect(migration.renamed).toEqual({ gemini: "custom-gemini-2", gpt: "custom-gpt" });
    expect(migration.definitions.map((agent) => agent.name)).toEqual(["custom-gemini-2", "custom-gemini", "custom-gpt"]);
    expect(migration.definitions[0]?.command).toBe("gemini");
    expect(migration.definitions[2]?.command).toBe("gpt-acp");
  });

  it("preserves execution fields and availability when migrating custom ids", () => {
    const definitions = [
      { name: "gemini", label: "Custom Gemini", command: "gemini", installHint: "Install Gemini" },
      { name: "gpt", label: "Custom GPT", command: "gpt", launchCommand: 'gpt-acp --profile "custom profile"  --stdio' },
    ];
    const migration = migrateCollidingCustomAgentNames(definitions);

    expect(migration.definitions).toEqual([
      { ...definitions[0], name: "custom-gemini", registryCommand: "gemini --acp" },
      { ...definitions[1], name: "custom-gpt" },
    ]);
    const probes: string[] = [];
    const options = toAgentOptions(migration.definitions, (command) => {
      probes.push(command);
      return command === "gemini";
    });
    expect(probes).toEqual(["gemini"]);
    expect(options.map((option) => option.available)).toEqual([true, true]);
    expect(agentRegistryOverrides(migration.definitions)).toEqual({
      "custom-gemini": "gemini --acp",
      "custom-gpt": definitions[1]!.launchCommand,
    });
  });

  it("injects a bundled adapter launchCommand for built-in adapter agents", () => {
    const wired = withAdapterLaunchCommands(
      DEFAULT_AGENTS,
      (adapter) => `/app/out/adapters/${adapter}/index.js`,
      ["/usr/bin/node"],
    );
    expect(wired.find((a) => a.name === "gemini")?.launchCommand).toBe(
      "/usr/bin/node /app/out/adapters/antigravity/index.js",
    );
    expect(wired.find((a) => a.name === "gpt")?.launchCommand).toBe(
      "/usr/bin/node /app/out/adapters/codex/index.js",
    );
  });

  it("supports an Electron-as-node launcher and quotes paths with spaces", () => {
    const wired = withAdapterLaunchCommands(
      DEFAULT_AGENTS,
      (adapter) => `/Apps/Baby Menu.app/out/adapters/${adapter}/index.js`,
      ["env", "ELECTRON_RUN_AS_NODE=1", "/Apps/Baby Menu.app/Contents/MacOS/Baby Menu"],
    );
    expect(wired.find((a) => a.name === "gemini")?.launchCommand).toBe(
      'env ELECTRON_RUN_AS_NODE=1 "/Apps/Baby Menu.app/Contents/MacOS/Baby Menu" "/Apps/Baby Menu.app/out/adapters/antigravity/index.js"',
    );
  });

  it("does not override an explicit launchCommand for a built-in", () => {
    const configured = [{ name: "gemini", label: "Gemini", command: "agy", adapter: "antigravity" as const, launchCommand: "my-gemini" }];
    const wired = withAdapterLaunchCommands(configured, () => "/should/not/be/used");
    expect(wired[0]!.launchCommand).toBe("my-gemini");
  });

  it("does not let agents.json redirect a built-in away from its bundled adapter", () => {
    const catalog = resolveAgentCatalog({ config: [{ name: "gemini", launchCommand: "my-gemini-acp" }] });
    expect(catalog.find((agent) => agent.name === "gemini")?.launchCommand).toBeUndefined();
    expect(catalog.find((agent) => agent.name === "gemini")?.adapter).toBe("antigravity");
  });

  it("keeps probing wrapped CLIs for adapter-wired built-ins", () => {
    const wired = withAdapterLaunchCommands(DEFAULT_AGENTS, (a) => `/o/${a}.js`, ["node"]);
    const options = toAgentOptions(wired, (command) => command === "agy");
    const byName = Object.fromEntries(options.map((o) => [o.name, o.available]));
    expect(byName).toEqual({ gemini: true, gpt: false });
  });

  it("builds registry overrides from launchCommand (adapter-wired and custom)", () => {
    const wired = withAdapterLaunchCommands(DEFAULT_AGENTS, (a) => `/o/${a}.js`, ["node"]);
    const overrides = agentRegistryOverrides([...wired, { name: "custom", label: "Custom", command: "c", launchCommand: "node custom.js" }]);
    expect(overrides).toEqual({
      gemini: "node /o/antigravity.js",
      gpt: "node /o/codex.js",
      custom: "node custom.js",
    });
  });

  it("loadAgentConfigFile returns undefined for a missing file", async () => {
    expect(await loadAgentConfigFile("/no/such/file.json")).toBeUndefined();
  });

  it("registers the README's documented custom agent example as an available acpx override", () => {
    // Mirrors the agents.json example in README.md. Keep them in sync.
    const config = [{ name: "pi", label: "Pi", launchCommand: "npx pi-acp" }];
    const catalog = withAdapterLaunchCommands(resolveAgentCatalog({ config }), (a) => `/o/${a}.js`, ["node"]);

    expect(agentRegistryOverrides(catalog).pi).toBe("npx pi-acp");
    // No CLI on PATH, yet a launchCommand-only custom agent is still available.
    const pi = toAgentOptions(catalog, () => false).find((option) => option.name === "pi");
    expect(pi).toMatchObject({ name: "pi", label: "Pi", available: true, custom: true, command: "npx pi-acp" });
  });

  it("exposes the built-in agent names", () => {
    expect(BUILT_IN_AGENT_NAMES).toEqual(new Set(["gemini", "gpt"]));
  });

  it("toAgentOptions flags custom agents and exposes their launch command", () => {
    const wired = withAdapterLaunchCommands(DEFAULT_AGENTS, (a) => `/o/${a}.js`, ["node"]);
    const catalog = [...wired, { name: "rovo", label: "Rovo", command: "rovo", launchCommand: "rovo acp" }];
    const options = toAgentOptions(catalog, () => false);
    const gemini = options.find((o) => o.name === "gemini")!;
    const rovo = options.find((o) => o.name === "rovo")!;
    expect(gemini.custom).toBe(false);
    expect(gemini.command).toBeUndefined();
    expect(rovo.custom).toBe(true);
    expect(rovo.command).toBe("rovo acp");
    expect(rovo.available).toBe(true);
  });

  describe("validateCustomAgentInput", () => {
    it("normalizes a valid input (trims, defaults label to name)", () => {
      expect(validateCustomAgentInput({ name: "  rovo ", command: "  rovo acp " }, [])).toEqual({
        name: "rovo",
        label: "rovo",
        command: "rovo acp",
      });
      expect(validateCustomAgentInput({ name: "g", label: " My G ", command: "g acp" }, []).label).toBe("My G");
    });

    it("rejects an empty name or command", () => {
      expect(() => validateCustomAgentInput({ name: "   ", command: "x" }, [])).toThrow(/name/i);
      expect(() => validateCustomAgentInput({ name: "x", command: "  " }, [])).toThrow(/command/i);
    });

    it("rejects names that collide with a built-in", () => {
      expect(() => validateCustomAgentInput({ name: "gemini", command: "x" }, [])).toThrow(/built-in/i);
      expect(() => validateCustomAgentInput({ name: "GPT", command: "x" }, [])).toThrow(/built-in/i);
    });

    it("rejects a duplicate custom name (case-insensitive)", () => {
      expect(() => validateCustomAgentInput({ name: "rovo", command: "x" }, ["rovo"])).toThrow(/already/i);
      expect(() => validateCustomAgentInput({ name: "Rovo", command: "x" }, ["rovo"])).toThrow(/already/i);
    });

    it("rejects an invalid id pattern", () => {
      expect(() => validateCustomAgentInput({ name: "has space", command: "x" }, [])).toThrow(/letters|invalid/i);
      expect(() => validateCustomAgentInput({ name: "-bad", command: "x" }, [])).toThrow(/letters|invalid/i);
    });

    it("customAgentToDefinition maps command to launchCommand with no adapter", () => {
      expect(customAgentToDefinition({ name: "rovo", label: "Rovo", command: "rovo acp" })).toEqual({
        name: "rovo",
        label: "Rovo",
        command: "rovo",
        launchCommand: "rovo acp",
      });
    });
  });
});
