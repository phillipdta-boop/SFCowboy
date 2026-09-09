import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { UserMenu } from "./UserMenu.js";
import * as api from "./api/client.js";

vi.mock("./api/client.js");

describe("UserMenu", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    Object.defineProperty(window, "location", { value: { href: "" }, writable: true });
  });

  it("shows the current user's name and role", () => {
    render(<UserMenu user={{ id: "u1", organizationId: "o1", email: "a@example.com", name: "Ada", role: "admin" }} />);
    expect(screen.getByText("Ada")).toBeInTheDocument();
  });

  it("logs out and redirects to /login when clicked", async () => {
    vi.mocked(api.logout).mockResolvedValue(undefined);
    render(<UserMenu user={{ id: "u1", organizationId: "o1", email: "a@example.com", name: "Ada", role: "member" }} />);

    fireEvent.click(screen.getByRole("button", { name: /log out/i }));

    await waitFor(() => expect(api.logout).toHaveBeenCalled());
    await waitFor(() => expect(window.location.href).toBe("/login"));
  });
});
