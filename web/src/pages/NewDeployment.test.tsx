// web/src/pages/NewDeployment.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import * as client from "../api/client.js";
import { NewDeployment } from "./NewDeployment.js";
import { OBJECTS_AND_CHILD_COMPONENTS, OBJECTS_AND_CHILD_COMPONENTS_TYPES } from "../metadataTypeGroups.js";

vi.mock("../api/client.js");

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => mockNavigate };
});

beforeEach(() => {
  mockNavigate.mockClear();
  vi.mocked(client.fetchConnections).mockResolvedValue([
    { id: "src1", type: "org", nickname: "Dev", createdAt: "", lastUsedAt: null },
    { id: "tgt1", type: "org", nickname: "QA", createdAt: "", lastUsedAt: null },
  ]);
  vi.mocked(client.fetchMetadataTypes).mockResolvedValue(["ApexClass", "Flow"]);
  vi.mocked(client.createDraftDeployment).mockResolvedValue({ id: "draft-1" });
  vi.mocked(client.saveDeploymentComponents).mockResolvedValue({ id: "draft-1" });
});

async function saveDraft() {
  fireEvent.change(await screen.findByLabelText(/^source/i), { target: { value: "src1" } });
  fireEvent.change(screen.getByLabelText(/^target/i), { target: { value: "tgt1" } });
  fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
  await screen.findByRole("combobox", { name: /metadata types/i });
}

function pickMetadataType(type: string) {
  fireEvent.focus(screen.getByRole("combobox", { name: /metadata types/i }));
  fireEvent.mouseDown(screen.getByRole("option", { name: type }));
}

describe("NewDeployment page", () => {
  it("shows Title, Source, Target and Save/Cancel before anything is saved", async () => {
    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );
    expect(await screen.findByLabelText(/^title/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^source/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^target/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^save$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^cancel$/i })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /metadata types/i })).not.toBeInTheDocument();
  });

  it("disables Save until both a source and target are chosen", async () => {
    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );
    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
    fireEvent.change(await screen.findByLabelText(/^source/i), { target: { value: "src1" } });
    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/^target/i), { target: { value: "tgt1" } });
    expect(screen.getByRole("button", { name: /^save$/i })).not.toBeDisabled();
  });

  it("navigates back to the deployments list when Cancel is clicked", async () => {
    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );
    fireEvent.click(await screen.findByRole("button", { name: /^cancel$/i }));
    expect(mockNavigate).toHaveBeenCalledWith("/deploy");
  });

  it("creates a draft deployment with the optional title on Save and moves to the component picker", async () => {
    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );
    fireEvent.change(await screen.findByLabelText(/^title/i), { target: { value: "Sprint 12 release" } });
    await saveDraft();

    expect(client.createDraftDeployment).toHaveBeenCalledWith({
      title: "Sprint 12 release",
      sourceConnectionId: "src1",
      targetConnectionId: "tgt1",
    });
    expect(screen.queryByLabelText(/^title/i)).not.toBeInTheDocument();
  });

  it("omits the title from the draft when left blank", async () => {
    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );
    await saveDraft();

    expect(client.createDraftDeployment).toHaveBeenCalledWith({
      title: undefined,
      sourceConnectionId: "src1",
      targetConnectionId: "tgt1",
    });
  });

  it("shows an error and stays on the save step when creating the draft fails", async () => {
    vi.mocked(client.createDraftDeployment).mockRejectedValue(new Error("target org is unreachable"));
    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );
    fireEvent.change(await screen.findByLabelText(/^source/i), { target: { value: "src1" } });
    fireEvent.change(screen.getByLabelText(/^target/i), { target: { value: "tgt1" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("target org is unreachable");
    expect(screen.getByLabelText(/^source/i)).toBeInTheDocument();
  });

  it("shows the title with the source and target org once the draft is saved", async () => {
    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );
    await saveDraft();
    expect(screen.getByText(/Dev.*→.*QA/)).toBeInTheDocument();
  });

  it("fetches metadata types for the chosen source once the draft is saved", async () => {
    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );
    await saveDraft();
    expect(client.fetchMetadataTypes).toHaveBeenCalledWith("src1");
  });

  it("loads a diff scoped to the selected metadata types and pre-selects added/modified components", async () => {
    vi.mocked(client.fetchDiff).mockResolvedValue([
      { type: "ApexClass", fullName: "MyClass", status: "added" },
      { type: "ApexClass", fullName: "Removed", status: "removed" },
    ]);
    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );
    await saveDraft();

    pickMetadataType("ApexClass");
    fireEvent.click(screen.getByRole("button", { name: /load diff/i }));

    await waitFor(() => expect(client.fetchDiff).toHaveBeenCalledWith("src1", "tgt1", ["ApexClass"]));
    await screen.findByText("MyClass");
    const addedCheckbox = screen.getByRole("checkbox", { name: "MyClass" }) as HTMLInputElement;
    const removedCheckbox = screen.getByRole("checkbox", { name: "Removed" }) as HTMLInputElement;
    expect(addedCheckbox.checked).toBe(true);
    expect(removedCheckbox.checked).toBe(false);
  });

  it("shows nothing in the results area before a diff has been loaded", async () => {
    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );
    await saveDraft();

    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows a loading spinner while the diff loads, then replaces it with the table", async () => {
    let resolveDiff!: (items: unknown[]) => void;
    vi.mocked(client.fetchDiff).mockReturnValue(
      new Promise((resolve) => {
        resolveDiff = resolve as (items: unknown[]) => void;
      }) as ReturnType<typeof client.fetchDiff>
    );

    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );
    await saveDraft();
    pickMetadataType("ApexClass");
    fireEvent.click(screen.getByRole("button", { name: /load diff/i }));

    expect(await screen.findByRole("status")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /loading/i })).toBeDisabled();

    resolveDiff([{ type: "ApexClass", fullName: "MyClass", status: "added" }]);

    await screen.findByText("MyClass");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("autosaves the component selection to the draft as it changes, without running it", async () => {
    vi.mocked(client.fetchDiff).mockResolvedValue([{ type: "ApexClass", fullName: "MyClass", status: "added" }]);
    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );
    await saveDraft();
    pickMetadataType("ApexClass");
    fireEvent.click(screen.getByRole("button", { name: /load diff/i }));
    await screen.findByText("MyClass");

    await waitFor(() =>
      expect(client.saveDeploymentComponents).toHaveBeenCalledWith("draft-1", {
        components: [{ type: "ApexClass", fullName: "MyClass", action: "add" }],
        testLevel: "NoTestRun",
        validateOnly: false,
        ignoreWarnings: false,
        allowMissingFiles: false,
        autoUpdatePackage: false,
        runTests: [],
      })
    );
    expect(client.runDeployment).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox", { name: "MyClass" }));

    await waitFor(() =>
      expect(client.saveDeploymentComponents).toHaveBeenCalledWith("draft-1", {
        components: [],
        testLevel: "NoTestRun",
        validateOnly: false,
        ignoreWarnings: false,
        allowMissingFiles: false,
        autoUpdatePackage: false,
        runTests: [],
      })
    );
  });

  it("shows a Validate/Deploy toolbar at the top, disabled until something is selected", async () => {
    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );
    await saveDraft();

    expect(screen.getByRole("button", { name: /^validate$/i })).toBeDisabled();
    expect(screen.getAllByRole("button", { name: /^deploy$/i })[0]).toBeDisabled();
  });

  it("also shows Clone, Edit, and Delete in the toolbar, wired to navigate on clone/delete", async () => {
    vi.mocked(client.cloneDeployment).mockResolvedValue({ id: "clone-1" });
    vi.mocked(client.deleteDeployment).mockResolvedValue(undefined);
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));

    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );
    await saveDraft();

    fireEvent.click(screen.getByRole("button", { name: /^clone$/i }));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/deployments/clone-1"));

    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/deploy"));

    vi.unstubAllGlobals();
  });

  it("runs a validation from the top toolbar regardless of the Validate only checkbox below the table", async () => {
    vi.mocked(client.fetchDiff).mockResolvedValue([{ type: "ApexClass", fullName: "MyClass", status: "added" }]);
    vi.mocked(client.runDeployment).mockResolvedValue({ id: "draft-1" });

    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );
    await saveDraft();
    pickMetadataType("ApexClass");
    fireEvent.click(screen.getByRole("button", { name: /load diff/i }));
    await screen.findByText("MyClass");

    fireEvent.click(screen.getByRole("button", { name: /^validate$/i }));

    await waitFor(() =>
      expect(client.runDeployment).toHaveBeenCalledWith("draft-1", {
        components: [{ type: "ApexClass", fullName: "MyClass", action: "add" }],
        testLevel: "NoTestRun",
        validateOnly: true,
        ignoreWarnings: false,
        allowMissingFiles: false,
        autoUpdatePackage: false,
        runTests: [],
      })
    );
    expect(mockNavigate).toHaveBeenCalledWith("/deployments/draft-1");
  });

  it("runs a real deploy from the top toolbar even when the Validate only checkbox is checked", async () => {
    vi.mocked(client.fetchDiff).mockResolvedValue([{ type: "ApexClass", fullName: "MyClass", status: "added" }]);
    vi.mocked(client.runDeployment).mockResolvedValue({ id: "draft-1" });

    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );
    await saveDraft();
    pickMetadataType("ApexClass");
    fireEvent.click(screen.getByRole("button", { name: /load diff/i }));
    await screen.findByText("MyClass");
    // The checkbox lives in the Deploy Options tab now.
    fireEvent.click(screen.getByRole("tab", { name: /deploy options/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /validate only/i }));

    fireEvent.click(screen.getAllByRole("button", { name: /^deploy$/i })[0]);

    await waitFor(() =>
      expect(client.runDeployment).toHaveBeenCalledWith("draft-1", {
        components: [{ type: "ApexClass", fullName: "MyClass", action: "add" }],
        testLevel: "NoTestRun",
        validateOnly: false,
        ignoreWarnings: false,
        allowMissingFiles: false,
        autoUpdatePackage: false,
        runTests: [],
      })
    );
  });

  it("runs the deployment with the selected components and navigates to its detail page", async () => {
    vi.mocked(client.fetchDiff).mockResolvedValue([{ type: "ApexClass", fullName: "MyClass", status: "added" }]);
    vi.mocked(client.runDeployment).mockResolvedValue({ id: "draft-1" });

    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );
    await saveDraft();
    pickMetadataType("ApexClass");
    fireEvent.click(screen.getByRole("button", { name: /load diff/i }));
    await screen.findByText("MyClass");

    fireEvent.click(screen.getByRole("button", { name: /^deploy$/i }));

    await waitFor(() =>
      expect(client.runDeployment).toHaveBeenCalledWith("draft-1", {
        components: [{ type: "ApexClass", fullName: "MyClass", action: "add" }],
        testLevel: "NoTestRun",
        validateOnly: false,
        ignoreWarnings: false,
        allowMissingFiles: false,
        autoUpdatePackage: false,
        runTests: [],
      })
    );
    expect(mockNavigate).toHaveBeenCalledWith("/deployments/draft-1");
  });

  it("shows an error message when running the deployment fails", async () => {
    vi.mocked(client.fetchDiff).mockResolvedValue([{ type: "ApexClass", fullName: "MyClass", status: "added" }]);
    vi.mocked(client.runDeployment).mockRejectedValue(new Error("target org is unreachable"));

    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );
    await saveDraft();
    pickMetadataType("ApexClass");
    fireEvent.click(screen.getByRole("button", { name: /load diff/i }));
    await screen.findByText("MyClass");

    fireEvent.click(screen.getByRole("button", { name: /^deploy$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("target org is unreachable");
    expect(mockNavigate).not.toHaveBeenCalledWith(expect.stringContaining("/deployments/"));
  });

  it("also runs the deployment from the Deploy Options tab's own Deploy button", async () => {
    vi.mocked(client.fetchDiff).mockResolvedValue([{ type: "ApexClass", fullName: "MyClass", status: "added" }]);
    vi.mocked(client.runDeployment).mockResolvedValue({ id: "draft-1" });

    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );
    await saveDraft();
    pickMetadataType("ApexClass");
    fireEvent.click(screen.getByRole("button", { name: /load diff/i }));
    await screen.findByText("MyClass");
    fireEvent.click(screen.getByRole("tab", { name: /deploy options/i }));

    // Now two "Deploy" buttons exist (the top toolbar plus this tab's own) — this exercises the
    // tab's button specifically.
    fireEvent.click(screen.getAllByRole("button", { name: /^deploy$/i }).at(-1)!);

    await waitFor(() =>
      expect(client.runDeployment).toHaveBeenCalledWith("draft-1", {
        components: [{ type: "ApexClass", fullName: "MyClass", action: "add" }],
        testLevel: "NoTestRun",
        validateOnly: false,
        ignoreWarnings: false,
        allowMissingFiles: false,
        autoUpdatePackage: false,
        runTests: [],
      })
    );
    expect(mockNavigate).toHaveBeenCalledWith("/deployments/draft-1");
  });

  it("includes Test level, Ignore warnings, Allow missing components, and Auto update package on the Deploy Options tab", async () => {
    vi.mocked(client.fetchDiff).mockResolvedValue([{ type: "ApexClass", fullName: "MyClass", status: "added" }]);
    vi.mocked(client.runDeployment).mockResolvedValue({ id: "draft-1" });

    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );
    await saveDraft();
    pickMetadataType("ApexClass");
    fireEvent.click(screen.getByRole("button", { name: /load diff/i }));
    await screen.findByText("MyClass");
    fireEvent.click(screen.getByRole("tab", { name: /deploy options/i }));

    fireEvent.change(screen.getByLabelText(/test level/i), { target: { value: "RunLocalTests" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /^ignore warnings$/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /allow missing components/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /auto update package/i }));

    fireEvent.click(screen.getAllByRole("button", { name: /^deploy$/i }).at(-1)!);

    await waitFor(() =>
      expect(client.runDeployment).toHaveBeenCalledWith("draft-1", {
        components: [{ type: "ApexClass", fullName: "MyClass", action: "add" }],
        testLevel: "RunLocalTests",
        validateOnly: false,
        ignoreWarnings: true,
        allowMissingFiles: true,
        autoUpdatePackage: true,
        runTests: [],
      })
    );
  });

  it("only shows the Select Tests box for RunSpecifiedTests, and parses it into a comma-separated list on deploy", async () => {
    vi.mocked(client.fetchDiff).mockResolvedValue([{ type: "ApexClass", fullName: "MyClass", status: "added" }]);
    vi.mocked(client.runDeployment).mockResolvedValue({ id: "draft-1" });

    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );
    await saveDraft();
    pickMetadataType("ApexClass");
    fireEvent.click(screen.getByRole("button", { name: /load diff/i }));
    await screen.findByText("MyClass");
    fireEvent.click(screen.getByRole("tab", { name: /deploy options/i }));

    expect(screen.queryByLabelText(/select tests/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/test level/i), { target: { value: "RunSpecifiedTests" } });

    const deployButton = screen.getAllByRole("button", { name: /^deploy$/i }).at(-1)!;
    expect(deployButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/select tests/i), { target: { value: "MyClassTest, OtherClassTest," } });
    expect(deployButton).not.toBeDisabled();

    fireEvent.click(deployButton);

    await waitFor(() =>
      expect(client.runDeployment).toHaveBeenCalledWith("draft-1", {
        components: [{ type: "ApexClass", fullName: "MyClass", action: "add" }],
        testLevel: "RunSpecifiedTests",
        validateOnly: false,
        ignoreWarnings: false,
        allowMissingFiles: false,
        autoUpdatePackage: false,
        runTests: ["MyClassTest", "OtherClassTest"],
      })
    );
  });

  it("shows an error message when loading the diff fails", async () => {
    vi.mocked(client.fetchDiff).mockRejectedValue(new Error("source connection is invalid"));

    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );
    await saveDraft();
    pickMetadataType("ApexClass");
    fireEvent.click(screen.getByRole("button", { name: /load diff/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("source connection is invalid");
  });

  it("shows All Components and Components Selected tabs with live counts", async () => {
    vi.mocked(client.fetchDiff).mockResolvedValue([
      { type: "ApexClass", fullName: "MyClass", status: "added" },
      { type: "ApexClass", fullName: "Removed", status: "removed" },
    ]);
    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );
    await saveDraft();
    pickMetadataType("ApexClass");
    fireEvent.click(screen.getByRole("button", { name: /load diff/i }));
    await screen.findByText("MyClass");

    expect(screen.getByRole("tab", { name: /all components \(2\)/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /components selected \(1\)/i })).toBeInTheDocument();
  });

  it("shows only selected components with a Remove action on the Components Selected tab", async () => {
    vi.mocked(client.fetchDiff).mockResolvedValue([
      { type: "ApexClass", fullName: "MyClass", status: "added" },
      { type: "ApexClass", fullName: "Removed", status: "removed" },
    ]);
    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );
    await saveDraft();
    pickMetadataType("ApexClass");
    fireEvent.click(screen.getByRole("button", { name: /load diff/i }));
    await screen.findByText("MyClass");

    fireEvent.click(screen.getByRole("tab", { name: /components selected/i }));

    expect(screen.getByText("MyClass")).toBeInTheDocument();
    expect(screen.queryByText("Removed")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove myclass/i })).toBeInTheDocument();
  });

  it("deselects a component when removed from the Components Selected tab", async () => {
    vi.mocked(client.fetchDiff).mockResolvedValue([{ type: "ApexClass", fullName: "MyClass", status: "added" }]);
    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );
    await saveDraft();
    pickMetadataType("ApexClass");
    fireEvent.click(screen.getByRole("button", { name: /load diff/i }));
    await screen.findByText("MyClass");

    fireEvent.click(screen.getByRole("tab", { name: /components selected/i }));
    fireEvent.click(screen.getByRole("button", { name: /remove myclass/i }));

    expect(screen.getByRole("tab", { name: /components selected \(0\)/i })).toBeInTheDocument();
  });

  it("expands the Objects & Child Components umbrella type into its real metadata types when loading the diff", async () => {
    vi.mocked(client.fetchDiff).mockResolvedValue([]);
    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );
    await saveDraft();
    pickMetadataType(OBJECTS_AND_CHILD_COMPONENTS);
    fireEvent.click(screen.getByRole("button", { name: /load diff/i }));

    await waitFor(() => expect(client.fetchDiff).toHaveBeenCalled());
    const [, , types] = vi.mocked(client.fetchDiff).mock.lastCall!;
    expect(types).toEqual(expect.arrayContaining(OBJECTS_AND_CHILD_COMPONENTS_TYPES));
    expect(types).not.toContain(OBJECTS_AND_CHILD_COMPONENTS);
  });

  it("shows an error message when loading metadata types fails", async () => {
    vi.mocked(client.fetchMetadataTypes).mockRejectedValue(new Error("could not describe org"));

    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );
    fireEvent.change(await screen.findByLabelText(/^source/i), { target: { value: "src1" } });
    fireEvent.change(screen.getByLabelText(/^target/i), { target: { value: "tgt1" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("could not describe org");
  });
});
