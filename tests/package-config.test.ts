import { access, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { parse } from "yaml";
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
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["scripts/build-adapters.mjs"], { stdio: "ignore" });
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`adapter build exited ${code}`)));
    });
    await Promise.all([
      access(new URL("../out/adapters/antigravity/index.mjs", import.meta.url)),
      access(new URL("../out/adapters/codex/index.mjs", import.meta.url)),
    ]);
    const config = parse(await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8")) as { asarUnpack?: string[] };
    expect(config.asarUnpack).toContain("out/adapters/**");
  });
});
