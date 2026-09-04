/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { helloWorldWidget } from "../extensions/hello-world/widget";

const writeText = vi.fn(async () => undefined);

beforeEach(() => {
  writeText.mockClear();
  Object.assign(navigator, { clipboard: { writeText } });
});

afterEach(() => {
  cleanup();
});

describe("hello-world widget examples", () => {
  it.each([
    "add a widget tracking my Gemini quota from Antigravity",
    "add a widget tracking my GPT quota from Codex",
  ])("renders and copies the example: %s", async (prompt) => {
    render(<>{helloWorldWidget.render()}</>);
    const button = screen.getByRole("button", {
      name: new RegExp(prompt, "i"),
    });
    expect(button.tagName).toBe("BUTTON");
    fireEvent.click(button);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(prompt));
  });

  it("shows transient copied feedback after a click", async () => {
    render(<>{helloWorldWidget.render()}</>);
    const prompt = "add a widget tracking my GPT quota from Codex";
    fireEvent.click(screen.getByRole("button", { name: new RegExp(prompt, "i") }));

    await waitFor(() => expect(screen.getByText(/copied/i)).toBeTruthy());
  });
});
