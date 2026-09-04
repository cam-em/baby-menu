/* @vitest-environment jsdom */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRecipes } from "../src/main/recipe-loader";
import { getRecipesDir } from "../src/shared/paths";

describe("loadRecipes", () => {
  it("resolves recipes inside the active extension workspace", () => {
    expect(getRecipesDir("/repo")).toBe("/repo/extensions/recipes");
  });

  it("discovers the initial HTML recipes with titles", async () => {
    const recipes = await loadRecipes(resolve(import.meta.dirname, "../extensions/recipes/"));

    expect(recipes.map((recipe) => recipe.id).sort()).toEqual([
      "claude-code-quota",
      "codex-quota",
      "copilot-quota",
      "cursor-quota",
      "gemini-antigravity-quota",
      "grok-quota",
    ]);
    expect(recipes.every((recipe) => recipe.title.length > 0)).toBe(true);
  });

  it("declares browser-consumed theme and stylesheet conventions for quota recipes", async () => {
    const recipeUrls = [
      resolve(import.meta.dirname, "../extensions/recipes/claude-code-quota.html"),
      resolve(import.meta.dirname, "../extensions/recipes/codex-quota.html"),
      resolve(import.meta.dirname, "../extensions/recipes/copilot-quota.html"),
      resolve(import.meta.dirname, "../extensions/recipes/cursor-quota.html"),
      resolve(import.meta.dirname, "../extensions/recipes/gemini-antigravity-quota.html"),
      resolve(import.meta.dirname, "../extensions/recipes/grok-quota.html"),
    ];

    for (const recipeUrl of recipeUrls) {
      const html = await readFile(recipeUrl, "utf8");
      const document = new DOMParser().parseFromString(html, "text/html");
      expect(document.documentElement.dataset.theme).toBe("wireframe");
      expect(Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'), (link) => link.href))
        .toEqual(expect.arrayContaining([
          "https://cdn.jsdelivr.net/npm/daisyui@5",
          "https://cdn.jsdelivr.net/npm/daisyui@5/themes.css",
        ]));
      expect(Array.from(document.scripts, (script) => script.src))
        .toContain("https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4");
      expect(document.querySelectorAll("style")).toHaveLength(0);
    }
  });

  it("keeps Copilot transient 403 handling separate from token rejection", async () => {
    const html = await readFile(resolve(import.meta.dirname, "../extensions/recipes/copilot-quota.html"), "utf8");

    expect(html).toContain("Do not classify every <code>403</code> as rejected auth");
    expect(html).toContain("<code>x-ratelimit-remaining: 0</code>");
    expect(html).toContain("<code>x-ratelimit-reset</code> only when <code>x-ratelimit-remaining</code> is <code>0</code>");
    expect(html).toContain("<code>retry-after</code>");
    expect(html).toContain("secondary rate limits");
    expect(html).not.toContain("a future <code>x-ratelimit-reset</code>");
  });

  it("keeps Copilot local auth parse failures out of sign-in-required handling", async () => {
    const html = await readFile(resolve(import.meta.dirname, "../extensions/recipes/copilot-quota.html"), "utf8");

    expect(html).toContain("any existing apps.json file was unreadable or malformed");
    expect(html).toContain("follow the cached-stale-or-unavailable path instead of reporting sign-in required");
    expect(html).toContain("return an unavailable error (<code>Copilot quota unavailable</code>) with <code>sourceTried: [\"local-auth\"]</code>");
    expect(html).toContain("no existing apps.json file failed read or parse");
    expect(html).not.toContain("no file parses successfully, or no entry has a usable <code>oauth_token</code>, return <code>Copilot sign-in required</code>");
  });

  it("keeps Grok local auth parse failures out of sign-in-required handling", async () => {
    const html = await readFile(resolve(import.meta.dirname, "../extensions/recipes/grok-quota.html"), "utf8");

    expect(html).toContain("a missing resolved file is <code>auth_source_missing</code>");
    expect(html).toContain("a permission, I/O, or other read failure is <code>auth_source_unreadable</code>");
    expect(html).toContain("invalid JSON is <code>auth_source_malformed</code>");
    expect(html).toContain("no usable credential is <code>auth_source_incompatible</code>");
    expect(html).toContain("Do not run a CLI capability probe for missing, unreadable, malformed, incompatible, ambiguous, or healthy auth");
    expect(html).toContain("conditional official-client refresh");
    expect(html).toContain("Do not classify these local source outcomes as <code>parse_incompatible</code> or sign-in-required");
    expect(html).not.toContain("missing file, empty object, or no candidate with a non-empty <code>key</code>");
    expect(html).not.toContain("return <code>Grok sign-in required</code> with <code>sourceTried: [\"local-auth\"]</code>");
  });

  it("keeps Cursor sqlite auth reads scoped to used keys", async () => {
    const html = await readFile(resolve(import.meta.dirname, "../extensions/recipes/cursor-quota.html"), "utf8");

    expect(html).toContain("WHERE key IN ('cursorAuth/accessToken', 'cursorAuth/cachedEmail', 'cursorAuth/stripeMembershipType')");
    expect(html).toContain("do not retrieve <code>cursorAuth/refreshToken</code> or any other unused secret");
    expect(html).not.toContain("WHERE key LIKE 'cursorAuth/%'");
  });
});
