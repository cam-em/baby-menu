import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeJsonFile } from "../src/main/atomic-json-file";
import { createAgentCatalogController } from "../src/main/agent-catalog-controller";
import { createPreferencesService } from "../src/main/preferences";

describe("atomic JSON symlink semantics", () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "baby-menu-atomic-json-")); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it.each([false, true])("updates a chained symlink target while preserving links (missing target=%s)", async (missing) => {
    const target = join(directory, "managed", "agents.json");
    await mkdir(join(directory, "managed"));
    if (!missing) await writeFile(target, "[]");
    await symlink("managed/agents.json", join(directory, "intermediate.json"));
    const entry = join(directory, "agents.json");
    await symlink(join(directory, "intermediate.json"), entry);
    await writeJsonFile(entry, [{ name: "custom-gemini" }]);
    expect((await lstat(entry)).isSymbolicLink()).toBe(true);
    expect(await readlink(entry)).toBe(join(directory, "intermediate.json"));
    expect(await readlink(join(directory, "intermediate.json"))).toBe("managed/agents.json");
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual([{ name: "custom-gemini" }]);
  });

  it("resolves a relative link from its physical parent directory", async () => {
    await mkdir(join(directory, "managed", "nested"), { recursive: true });
    await symlink("managed/nested", join(directory, "alias"));
    await symlink("../target.json", join(directory, "managed", "nested", "config.json"));
    await writeJsonFile(join(directory, "alias", "config.json"), { preserved: true });
    expect(JSON.parse(await readFile(join(directory, "managed", "target.json"), "utf8"))).toEqual({ preserved: true });
    expect(await readlink(join(directory, "alias", "config.json"))).toBe("../target.json");
  });

  it("leaves links and their contents intact if serialization fails", async () => {
    const target = join(directory, "target.json");
    await writeFile(target, "[]");
    const entry = join(directory, "agents.json");
    await symlink("target.json", entry);
    await expect(writeJsonFile(entry, 1n)).rejects.toThrow();
    expect(await readlink(entry)).toBe("target.json");
    expect(await readFile(target, "utf8")).toBe("[]");
  });

  it("migrates linked catalog and preferences at their authoritative targets", async () => {
    await mkdir(join(directory, "managed"));
    await writeFile(join(directory, "managed", "agents.json"), JSON.stringify([{ name: "gemini", launchCommand: "custom-acp" }]));
    await writeFile(join(directory, "managed", "preferences.json"), JSON.stringify({ openAtLogin: false, agentName: "gemini" }));
    for (const file of ["agents.json", "preferences.json"]) await symlink(`managed/${file}`, join(directory, file));
    const preferences = createPreferencesService({ userDataDir: directory, app: { setLoginItemSettings: vi.fn() } });
    await createAgentCatalogController({
      agentsJsonPath: join(directory, "agents.json"), preferences,
      resolveAdapterPath: (adapter) => `${adapter}.mjs`, adapterLauncher: ["node"],
      commandExists: () => true, getActiveAgentName: () => "custom-gemini",
    }).load();
    for (const file of ["agents.json", "preferences.json"]) expect(await readlink(join(directory, file))).toBe(`managed/${file}`);
    expect(JSON.parse(await readFile(join(directory, "managed", "agents.json"), "utf8"))[0].name).toBe("custom-gemini");
    expect(JSON.parse(await readFile(join(directory, "managed", "preferences.json"), "utf8"))).toEqual({ openAtLogin: false, agentName: "custom-gemini" });
  });
});
