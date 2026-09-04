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
});
