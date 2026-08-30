import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { PipelineEnvironmentSummary } from "./PipelineEnvironmentSummary.js";

const CONNECTIONS = [
  { id: "a", type: "org" as const, nickname: "Dev", createdAt: "", lastUsedAt: null, orgType: "sandbox" as const },
  { id: "b", type: "org" as const, nickname: "QA", createdAt: "", lastUsedAt: null, orgType: "sandbox" as const },
  { id: "c", type: "org" as const, nickname: "Prod", createdAt: "", lastUsedAt: null, orgType: "production" as const },
  { id: "d", type: "git" as const, nickname: "Repo", createdAt: "", lastUsedAt: null },
];

describe("PipelineEnvironmentSummary", () => {
  it("renders one card item per connection, in order, with its nickname and environment badge", () => {
    render(<PipelineEnvironmentSummary connections={CONNECTIONS} connectionIds={["a", "b", "c"]} />);

    expect(screen.getByText("Dev")).toBeInTheDocument();
    expect(screen.getByText("QA")).toBeInTheDocument();
    expect(screen.getByText("Prod")).toBeInTheDocument();
    expect(screen.getAllByText("Sandbox")).toHaveLength(2);
    expect(screen.getByText("Production")).toHaveClass("badge-removed");
  });

  it("labels each stage with its position so the sequence stays clear at any length", () => {
    render(<PipelineEnvironmentSummary connections={CONNECTIONS} connectionIds={["a", "b", "c"]} />);

    expect(screen.getByText(/Stage 1/)).toBeInTheDocument();
    expect(screen.getByText(/Stage 2/)).toBeInTheDocument();
    expect(screen.getByText(/Stage 3/)).toBeInTheDocument();
  });

  it("draws an arrow between stages but not before the first one", () => {
    const { container } = render(<PipelineEnvironmentSummary connections={CONNECTIONS} connectionIds={["a", "b", "c"]} />);
    expect(container.querySelectorAll(".env-card-arrow")).toHaveLength(2);
  });

  it("scales to many stages without a fixed limit", () => {
    const manyConnections = Array.from({ length: 8 }, (_, i) => ({
      id: `c${i}`,
      type: "org" as const,
      nickname: `Env${i}`,
      createdAt: "",
      lastUsedAt: null,
      orgType: "sandbox" as const,
    }));
    const { container } = render(
      <PipelineEnvironmentSummary connections={manyConnections} connectionIds={manyConnections.map((c) => c.id)} />
    );

    expect(container.querySelectorAll(".env-card-item")).toHaveLength(8);
    expect(container.querySelectorAll(".env-card-arrow")).toHaveLength(7);
  });

  it("shows a GitHub icon for a git connection and a Salesforce icon for an org connection", () => {
    const { container } = render(<PipelineEnvironmentSummary connections={CONNECTIONS} connectionIds={["a", "d"]} />);
    const items = container.querySelectorAll(".env-card-item");
    expect(within(items[0] as HTMLElement).getByText("Sandbox")).toBeInTheDocument();
    expect(items[0].querySelector("path[fill='#00A1E0']")).toBeInTheDocument();
    expect(items[1].querySelector("svg[fill='currentColor']")).toBeInTheDocument();
  });
});
