import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

describe("fake agy clean-room configuration validation", () => {
  it.each([
    ["boolean fields", "---\ninheritCustomizations: false\ninheritMcp: false\n---\nInstructions", true],
    ["quoted keys", "---\n'inheritCustomizations': false\n'inheritMcp': false\n---\nInstructions", true],
    ["comments", "---\n# inheritCustomizations: false\n# inheritMcp: false\n---\nInstructions", false],
    ["body text", "---\nname: example\n---\ninheritCustomizations: false\ninheritMcp: false", false],
    ["string values", '---\ninheritCustomizations: "false"\ninheritMcp: "false"\n---\nInstructions', false],
    ["invalid YAML", "---\ninheritCustomizations: [\ninheritMcp: false\n---\nInstructions", false],
  ])("validates %s through the executable fake CLI", async (_label, source, expected) => {
    const directory = await mkdtemp(join(tmpdir(), "baby-menu-clean-room-test-"));
    try {
      const agentPath = join(directory, "agent.md");
      const evidencePath = join(directory, "clean-room.txt");
      await writeFile(agentPath, source as string);
      await run(process.execPath, [join(import.meta.dirname, "fixtures/fake-clis/fake-agy.mjs"), "--agent", agentPath, "--print=hello"], {
        env: { ...process.env, FAKE_AGY_CLEAN_ROOM_FILE: evidencePath },
      });
      expect(await readFile(evidencePath, "utf8")).toBe(String(expected));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
