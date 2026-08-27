import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DisplayNameField } from "./DisplayNameField.js";
import { getDisplayName } from "./displayName.js";

describe("DisplayNameField", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("starts empty and shows a placeholder when no name is stored", () => {
    render(<DisplayNameField />);
    const input = screen.getByRole("textbox", { name: /your name/i }) as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("Your name");
  });

  it("saves what's typed to the shared display name store immediately", () => {
    render(<DisplayNameField />);
    const input = screen.getByRole("textbox", { name: /your name/i });

    fireEvent.change(input, { target: { value: "Phillip" } });

    expect(getDisplayName()).toBe("Phillip");
  });

  it("picks up a previously stored name on mount", () => {
    localStorage.setItem("sfcowboy-display-name", "Phillip");
    render(<DisplayNameField />);
    expect(screen.getByRole("textbox", { name: /your name/i })).toHaveValue("Phillip");
  });
});
