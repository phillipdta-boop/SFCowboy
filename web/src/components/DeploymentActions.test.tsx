// web/src/components/DeploymentActions.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import * as client from "../api/client.js";
import { DeploymentActions } from "./DeploymentActions.js";

vi.mock("../api/client.js");

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(client.updateDeploymentTitle).mockResolvedValue({ id: "d1" });
  vi.mocked(client.deleteDeployment).mockResolvedValue(undefined);
  vi.mocked(client.cloneDeployment).mockResolvedValue({ id: "clone-1" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderActions(overrides: Partial<React.ComponentProps<typeof DeploymentActions>> = {}) {
  const onTitleChange = vi.fn();
  const onCloned = vi.fn();
  const onDeleted = vi.fn();
  render(
    <DeploymentActions
      deploymentId="d1"
      title="Sprint 12"
      onTitleChange={onTitleChange}
      onCloned={onCloned}
      onDeleted={onDeleted}
      {...overrides}
    />
  );
  return { onTitleChange, onCloned, onDeleted };
}

describe("DeploymentActions", () => {
  it("shows Clone, Edit, and Delete buttons", () => {
    renderActions();
    expect(screen.getByRole("button", { name: /^clone$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^edit$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^delete$/i })).toBeInTheDocument();
  });

  it("clones the deployment and reports the new id", async () => {
    const { onCloned } = renderActions();
    fireEvent.click(screen.getByRole("button", { name: /^clone$/i }));

    await waitFor(() => expect(client.cloneDeployment).toHaveBeenCalledWith("d1"));
    expect(onCloned).toHaveBeenCalledWith("clone-1");
  });

  it("shows an error and does not report cloned when cloning fails", async () => {
    vi.mocked(client.cloneDeployment).mockRejectedValue(new Error("could not clone"));
    const { onCloned } = renderActions();

    fireEvent.click(screen.getByRole("button", { name: /^clone$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("could not clone");
    expect(onCloned).not.toHaveBeenCalled();
  });

  it("asks for confirmation before deleting, and does nothing if declined", async () => {
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(false));
    const { onDeleted } = renderActions();

    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));

    expect(window.confirm).toHaveBeenCalled();
    expect(client.deleteDeployment).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("deletes the deployment once confirmed", async () => {
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
    const { onDeleted } = renderActions();

    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));

    await waitFor(() => expect(client.deleteDeployment).toHaveBeenCalledWith("d1"));
    expect(onDeleted).toHaveBeenCalled();
  });

  it("shows an error when deleting fails", async () => {
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
    vi.mocked(client.deleteDeployment).mockRejectedValue(new Error("cannot delete"));
    renderActions();

    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("cannot delete");
  });

  it("edits the title: Edit reveals a pre-filled input, Save persists it", async () => {
    const { onTitleChange } = renderActions({ title: "Sprint 12" });

    fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
    const input = screen.getByLabelText(/deployment title/i) as HTMLInputElement;
    expect(input.value).toBe("Sprint 12");

    fireEvent.change(input, { target: { value: "Sprint 13" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(client.updateDeploymentTitle).toHaveBeenCalledWith("d1", "Sprint 13"));
    expect(onTitleChange).toHaveBeenCalledWith("Sprint 13");
    // Back to the button row.
    expect(await screen.findByRole("button", { name: /^edit$/i })).toBeInTheDocument();
  });

  it("saves null when the title is cleared to blank", async () => {
    const { onTitleChange } = renderActions({ title: "Sprint 12" });

    fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
    fireEvent.change(screen.getByLabelText(/deployment title/i), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(client.updateDeploymentTitle).toHaveBeenCalledWith("d1", null));
    expect(onTitleChange).toHaveBeenCalledWith(null);
  });

  it("cancels editing without saving", () => {
    renderActions({ title: "Sprint 12" });

    fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
    fireEvent.change(screen.getByLabelText(/deployment title/i), { target: { value: "Something else" } });
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    expect(client.updateDeploymentTitle).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^edit$/i })).toBeInTheDocument();
  });

  it("shows an error and stays in edit mode when saving the title fails", async () => {
    vi.mocked(client.updateDeploymentTitle).mockRejectedValue(new Error("title too long"));
    renderActions({ title: "Sprint 12" });

    fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("title too long");
    expect(screen.getByLabelText(/deployment title/i)).toBeInTheDocument();
  });
});
