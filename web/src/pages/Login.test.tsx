import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Login } from "./Login.js";
import * as api from "../api/client.js";

vi.mock("../api/client.js");

describe("Login", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // jsdom doesn't implement navigation; Login redirects on success via window.location.href.
    Object.defineProperty(window, "location", { value: { href: "" }, writable: true });
  });

  it("submits email and password and redirects to / on success", async () => {
    vi.mocked(api.login).mockResolvedValue({ id: "u1", organizationId: "o1", email: "a@example.com", name: "A", role: "admin" });
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "a@example.com" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "password123" } });
    fireEvent.click(screen.getByRole("button", { name: /log in/i }));

    await waitFor(() => expect(api.login).toHaveBeenCalledWith("a@example.com", "password123"));
    await waitFor(() => expect(window.location.href).toBe("/"));
  });

  it("shows the server's error message on failed login", async () => {
    vi.mocked(api.login).mockRejectedValue(new Error("Invalid email or password"));
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "a@example.com" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: /log in/i }));

    expect(await screen.findByText("Invalid email or password")).toBeInTheDocument();
  });
});
