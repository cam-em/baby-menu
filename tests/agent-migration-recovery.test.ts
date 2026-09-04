import { mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentCatalogController } from "../src/main/agent-catalog-controller";
import { createPreferencesService } from "../src/main/preferences";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename), unlink: vi.fn(actual.unlink) };
});

const directories: string[] = [];
afterEach(async () => {
  vi.mocked(rename).mockReset();
  vi.mocked(unlink).mockReset();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(rename).mockImplementation(actual.rename);
  vi.mocked(unlink).mockImplementation(actual.unlink);
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("recoverable catalog and selection migration", () => {
  it.each([
    ["claude", "gemini", "gemini"],
    ["codex", "gpt", "gpt"],
    ["gemini", "gemini", "custom-gemini"],
    ["gpt", "gpt", "custom-gpt"],
  ])("retains saved %s with custom %s as %s at every write boundary", async (saved, custom, expected) => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    for (const boundary of ["journal", "preferences", "catalog", "retirement"]) {
      const directory = await mkdtemp(join(tmpdir(), "baby-menu-migration-"));
      directories.push(directory);
      const catalogPath = join(directory, "agents.json");
      const preferencesPath = join(directory, "preferences.json");
      const journalPath = join(directory, "agent-selection-migration.json");
      const original = { name: custom, label: "Custom", command: custom, launchCommand: "custom-acp --stdio" };
      await writeFile(catalogPath, JSON.stringify([original]));
      await writeFile(preferencesPath, JSON.stringify({ openAtLogin: false, agentName: saved }));
      const create = () => {
        const preferences = createPreferencesService({ userDataDir: directory, app: { setLoginItemSettings: vi.fn() } });
        const controller = createAgentCatalogController({
          agentsJsonPath: catalogPath,
          preferences,
          resolveAdapterPath: (adapter) => `${adapter}.mjs`,
          adapterLauncher: ["node"],
          commandExists: () => true,
          getActiveAgentName: () => expected,
        });
        return { preferences, controller };
      };
      const failure = new Error("interrupted migration");
      const target = boundary === "journal" ? journalPath : boundary === "preferences" ? preferencesPath : catalogPath;
      vi.mocked(rename).mockImplementation(async (from, to) => {
        if (boundary !== "retirement" && to === target) throw failure;
        await actual.rename(from, to);
      });
      vi.mocked(unlink).mockImplementation(async (path) => {
        if (boundary === "retirement" && path === journalPath) throw failure;
        await actual.unlink(path);
      });

      await expect(create().controller.load()).rejects.toBe(failure);
      if (boundary === "journal") {
        expect(JSON.parse(await readFile(preferencesPath, "utf8")).agentName).toBe(saved);
        expect(JSON.parse(await readFile(catalogPath, "utf8"))).toEqual([original]);
      } else {
        expect(JSON.parse(await readFile(journalPath, "utf8"))).toEqual({ version: 1, agentName: expected });
      }
      vi.mocked(rename).mockImplementation(actual.rename);
      vi.mocked(unlink).mockImplementation(actual.unlink);

      for (let restart = 0; restart < 2; restart += 1) {
        const { preferences, controller } = create();
        await controller.load();
        expect(await preferences.get()).toEqual({ openAtLogin: false, agentName: expected });
        expect(JSON.parse(await readFile(catalogPath, "utf8"))).toEqual([{ ...original, name: `custom-${custom}` }]);
        await expect(readFile(journalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      }
    }
  });
});
