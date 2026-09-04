import { readFile } from "node:fs/promises";
import packageJson from "../package.json";
import { describe, expect, it } from "vitest";

describe("package configuration", () => {
  it("pins dependency versions instead of using latest", () => {
    const dependencyGroups = [packageJson.dependencies, packageJson.devDependencies];
    const versions = dependencyGroups.flatMap((dependencies) => Object.entries(dependencies ?? {}));

    expect(versions).not.toEqual([]);
    expect(versions.filter(([, version]) => version === "latest")).toEqual([]);
  });

  it("declares the Node runtime expected by the Electron toolchain", () => {
    expect(packageJson.engines?.node).toBe(">=22.12");
  });

  it("downloads the Electron binary after dependency installation", () => {
    expect(packageJson.scripts?.postinstall).toBe("install-electron");
  });

  it("runs only the root test directory so generated dev workspaces are not discovered", () => {
    expect(packageJson.scripts?.test).toBe("vitest run tests");
  });

  it("provides an explicit command to destroy the generated dev extension workspace", () => {
    expect(packageJson.scripts?.["dev:reset"]).toBe("node scripts/dev.mjs --reset");
  });

  it("does not expose a direct start script that bypasses the packaged app path", () => {
    expect(packageJson.scripts).not.toHaveProperty("start");
  });

  it("bundles and unpacks both built-in ACP adapters", async () => {
    const buildScript = await readFile(new URL("../scripts/build-adapters.mjs", import.meta.url), "utf8");
    const builderConfig = await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8");
    expect(buildScript).toContain('const adapters = ["antigravity", "codex"]');
    expect(builderConfig).toContain("out/adapters/**");
  });
});
