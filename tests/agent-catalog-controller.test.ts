import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentCatalogController } from "../src/main/agent-catalog-controller";
import { createPreferencesService } from "../src/main/preferences";
import { createAgentRegistry } from "acpx/runtime";

describe("agent-catalog-controller", () => {
  let dir: string;
  let agentsJsonPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "baby-menu-agents-"));
    agentsJsonPath = join(dir, "agents.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function create(overrides: {
    active?: string;
    onChange?: (o: Record<string, string>) => void;
    onLoaded?: (r: Record<string, string>, names: string[]) => void | Promise<void>;
  } = {}) {
    return createAgentCatalogController({
      agentsJsonPath,
      resolveAdapterPath: (adapter) => `/o/${adapter}.js`,
      adapterLauncher: ["node"],
      commandExists: () => true,
      getActiveAgentName: () => overrides.active ?? "gemini",
      onCatalogLoaded: overrides.onLoaded,
      onOverridesChange: overrides.onChange,
    });
  }

  async function readJson() {
    return JSON.parse(await readFile(agentsJsonPath, "utf8")) as Array<Record<string, unknown>>;
  }

  it("starts with only the built-ins and their adapter overrides", async () => {
    const controller = await create().load();
    expect(controller.options().map((o) => o.name)).toEqual(["gemini", "gpt"]);
    expect(controller.overrides).toEqual({ gemini: "node /o/antigravity.js", gpt: "node /o/codex.js" });
  });

  it("adds a custom agent, persists it, rebuilds overrides, and notifies", async () => {
    const onChange = vi.fn();
    const controller = await create({ onChange }).load();

    const options = controller.options();
    void options;
    await controller.addAgent({ name: "rovo", label: "Rovo", command: "rovo acp" });

    expect(controller.options().find((o) => o.name === "rovo")).toMatchObject({
      name: "rovo",
      label: "Rovo",
      available: true,
      custom: true,
      command: "rovo acp",
    });
    expect(controller.overrides).toEqual({
      gemini: "node /o/antigravity.js",
      gpt: "node /o/codex.js",
      rovo: "rovo acp",
    });
    expect(onChange).toHaveBeenLastCalledWith(controller.overrides);
    expect(await readJson()).toEqual([{ name: "rovo", label: "Rovo", command: "rovo", launchCommand: "rovo acp" }]);
  });

  it("loads previously persisted custom agents", async () => {
    const first = await create().load();
    await first.addAgent({ name: "rovo", command: "rovo acp" });

    const second = await create().load();
    expect(second.options().map((o) => o.name)).toEqual(["gemini", "gpt", "rovo"]);
  });

  it("persists colliding custom ids and reports saved-reference migrations", async () => {
    await writeFile(agentsJsonPath, JSON.stringify([
      { name: "gemini", label: "Custom Gemini", launchCommand: "custom-gemini-acp" },
      { name: "custom-gemini", launchCommand: "existing-acp" },
    ]));
    const onMigrated = vi.fn();
    const controller = await create({ onLoaded: onMigrated }).load();
    expect(controller.options().map((option) => option.name)).toEqual(["gemini", "gpt", "custom-gemini-2", "custom-gemini"]);
    expect(onMigrated).toHaveBeenCalledWith({ gemini: "custom-gemini-2" }, ["gemini", "custom-gemini"]);
    expect((await readJson()).map((agent) => agent.name)).toEqual(["custom-gemini-2", "custom-gemini"]);
  });

  it.each(["gemini", "gpt"])("preserves implicit registry resolution for migrated %s across reloads", async (name) => {
    const original = { name, label: "Custom", command: name };
    await writeFile(agentsJsonPath, JSON.stringify([original]));
    const expectedCommand = createAgentRegistry().resolve(name);
    const first = await create().load();
    const second = await create().load();

    for (const controller of [first, second]) {
      expect(createAgentRegistry({ overrides: controller.overrides }).resolve(`custom-${name}`)).toBe(expectedCommand);
      expect(controller.catalog.find((agent) => agent.name === `custom-${name}`)).toMatchObject({
        command: original.command,
        registryCommand: expectedCommand,
      });
    }
    expect(await readJson()).toEqual([{ ...original, name: `custom-${name}`, registryCommand: expectedCommand }]);
  });

  it("retains explicit execution fields byte-for-byte through migration and reload", async () => {
    const original = {
      name: "gemini",
      label: "Custom Gemini",
      command: "gemini",
      launchCommand: '  gemini-acp --profile "custom profile"  --stdio  ',
      installHint: "Use the existing CLI",
    };
    await writeFile(agentsJsonPath, JSON.stringify([original]));
    await create().load();
    const restarted = await create().load();
    expect(await readJson()).toEqual([{ ...original, name: "custom-gemini" }]);
    expect(restarted.overrides["custom-gemini"]).toBe(original.launchCommand);
  });

  it.each([
    ["claude", "gemini", "gemini"],
    ["codex", "gpt", "gpt"],
    ["gemini", "gemini", "custom-gemini"],
    ["gpt", "gpt", "custom-gpt"],
    ["claude", "claude", "claude"],
    ["codex", "codex", "codex"],
  ])("migrates saved %s with custom %s to %s across restarts", async (saved, custom, expected) => {
    await writeFile(join(dir, "preferences.json"), JSON.stringify({ openAtLogin: false, agentName: saved }));
    await writeFile(agentsJsonPath, JSON.stringify([{ name: custom, launchCommand: "custom-acp --stdio" }]));
    for (let restart = 0; restart < 2; restart += 1) {
      const preferences = createPreferencesService({ userDataDir: dir, app: { setLoginItemSettings: vi.fn() } });
      await create({ onLoaded: async (renamed, names) => { await preferences.migrateAgentSelection(renamed, names); } }).load();
      expect((await preferences.apply()).agentName).toBe(expected);
      expect(JSON.parse(await readFile(join(dir, "preferences.json"), "utf8")).agentName).toBe(expected);
    }
  });

  it("rejects adding a name that collides with a built-in", async () => {
    const controller = await create().load();
    await expect(controller.addAgent({ name: "gemini", command: "x" })).rejects.toThrow(/built-in/i);
  });

  it("updates an existing custom agent's command", async () => {
    const controller = await create().load();
    await controller.addAgent({ name: "rovo", command: "rovo acp" });
    await controller.updateAgent("rovo", { command: "rovo acp --beta", label: "Rovo Beta" });

    expect(controller.overrides.rovo).toBe("rovo acp --beta");
    expect(controller.options().find((o) => o.name === "rovo")?.label).toBe("Rovo Beta");
  });

  it("removes a custom agent and persists the removal", async () => {
    const controller = await create({ active: "gemini" }).load();
    await controller.addAgent({ name: "rovo", command: "rovo acp" });
    await controller.removeAgent("rovo");

    expect(controller.options().map((o) => o.name)).toEqual(["gemini", "gpt"]);
    expect(controller.overrides.rovo).toBeUndefined();
    expect(await readJson()).toEqual([]);
  });

  it("refuses to remove the currently active agent", async () => {
    const controller = await create({ active: "rovo" }).load();
    await controller.addAgent({ name: "rovo", command: "rovo acp" });
    await expect(controller.removeAgent("rovo")).rejects.toThrow(/active|switch/i);
    expect(controller.options().find((o) => o.name === "rovo")).toBeTruthy();
  });
});
