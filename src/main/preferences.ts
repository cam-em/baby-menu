import { lstat, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { normalizeLegacyBuiltInAgentName } from "./agent-catalog";
import { writeJsonFile } from "./atomic-json-file";

export type BabyMenuPreferences = {
  openAtLogin: boolean;
  /** Persisted embedded-agent choice; absent until the user picks one. */
  agentName?: string;
};

type LoginItemApp = {
  setLoginItemSettings: (settings: { openAtLogin: boolean }) => void;
};

export type PreferencesService = {
  get: () => Promise<BabyMenuPreferences>;
  setOpenAtLogin: (openAtLogin: boolean) => Promise<BabyMenuPreferences>;
  setAgent: (agentName: string) => Promise<BabyMenuPreferences>;
  migrateAgentSelection: (renamed: Record<string, string>, customNames: readonly string[], environmentAgentName?: string) => Promise<BabyMenuPreferences>;
  completeAgentSelectionMigration: () => Promise<void>;
  apply: () => Promise<BabyMenuPreferences>;
};

type CreatePreferencesServiceOptions = {
  userDataDir: string;
  app: LoginItemApp;
  defaultOpenAtLogin?: boolean;
  allowOpenAtLogin?: boolean;
};

export function createPreferencesService({
  userDataDir,
  app,
  defaultOpenAtLogin = true,
  allowOpenAtLogin = true,
}: CreatePreferencesServiceOptions): PreferencesService {
  const filePath = join(userDataDir, "preferences.json");
  const migrationPath = join(userDataDir, "agent-selection-migration.json");

  function normalizePreferences(preferences: BabyMenuPreferences): BabyMenuPreferences {
    const agentName = preferences.agentName?.trim();
    return {
      openAtLogin: allowOpenAtLogin && preferences.openAtLogin,
      ...(agentName ? { agentName } : {}),
    };
  }

  function applyLoginItemSettings(preferences: BabyMenuPreferences): void {
    if (!allowOpenAtLogin) return;
    app.setLoginItemSettings({ openAtLogin: preferences.openAtLogin });
  }

  async function readPreferences(): Promise<BabyMenuPreferences> {
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        try {
          await lstat(filePath);
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === "ENOENT") {
            return normalizePreferences({ openAtLogin: defaultOpenAtLogin });
          }
        }
      }
      throw new Error("Preferences could not be loaded.");
    }
    try {
      const parsed = JSON.parse(content) as Partial<BabyMenuPreferences> | null;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
        || (parsed.openAtLogin !== undefined && typeof parsed.openAtLogin !== "boolean")
        || (parsed.agentName !== undefined && typeof parsed.agentName !== "string")) {
        throw new Error("Invalid preferences.");
      }
      return normalizePreferences({ openAtLogin: parsed.openAtLogin ?? defaultOpenAtLogin, agentName: parsed.agentName });
    } catch {
      throw new Error("Preferences could not be loaded.");
    }
  }

  async function writePreferences(preferences: BabyMenuPreferences): Promise<BabyMenuPreferences> {
    await writeJsonFile(filePath, preferences);
    return preferences;
  }

  async function pendingAgentSelection(): Promise<string | undefined> {
    let content: string;
    try {
      content = await readFile(migrationPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const pending = JSON.parse(content) as { version?: unknown; agentName?: unknown } | null;
    if (pending?.version !== 1 || typeof pending.agentName !== "string"
      || !/^(?:gemini|gpt|custom-(?:gemini|gpt)(?:-\d+)?)$/.test(pending.agentName)) {
      throw new Error("Invalid pending agent selection migration.");
    }
    return pending.agentName;
  }

  return {
    get: readPreferences,
    async migrateAgentSelection(renamed, customNames, environmentAgentName) {
      const pending = await pendingAgentSelection();
      const current = await readPreferences();
      if (pending) {
        return current.agentName === pending ? current : writePreferences({ ...current, agentName: pending });
      }
      const selected = current.agentName ?? environmentAgentName?.trim();
      if (!selected) return current;
      const customRenamed = Object.hasOwn(renamed, selected);
      const agentName = customRenamed ? renamed[selected] : normalizeLegacyBuiltInAgentName(selected, customNames);
      if (agentName === selected || (!current.agentName && !customRenamed)) return current;
      await writeJsonFile(migrationPath, { version: 1, agentName });
      return writePreferences({ ...current, agentName });
    },
    async completeAgentSelectionMigration() {
      await unlink(migrationPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    },
    async setOpenAtLogin(openAtLogin) {
      const current = await readPreferences();
      const preferences = await writePreferences(normalizePreferences({ ...current, openAtLogin }));
      applyLoginItemSettings(preferences);
      return preferences;
    },
    async setAgent(agentName) {
      const current = await readPreferences();
      return writePreferences(normalizePreferences({ ...current, agentName }));
    },
    async apply() {
      const preferences = await readPreferences();
      applyLoginItemSettings(preferences);
      return preferences;
    },
  };
}
