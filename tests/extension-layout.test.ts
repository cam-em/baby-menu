import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("extension layout", () => {
  it("keeps the dev extension workspace out of git without ignoring bundled extensions", () => {
    const result = spawnSync("git", ["-c", "core.excludesFile=/dev/null", "check-ignore", "--no-index", "--stdin"], {
      cwd: resolve(import.meta.dirname, ".."),
      input: "extensions-dev/example/widget.tsx\nextensions/hello-world/widget.tsx\n",
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(["extensions-dev/example/widget.tsx"]);
  });
});
