import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentCatalogController } from "../src/main/agent-catalog-controller";

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

  function create(overrides: { active?: string; onChange?: (o: Record<string, string>) => void } = {}) {
    return createAgentCatalogController({
      agentsJsonPath,
      resolveAdapterPath: (adapter) => `/o/${adapter}.js`,
      adapterLauncher: ["node"],
      commandExists: () => true,
      getActiveAgentName: () => overrides.active ?? "gemini",
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
