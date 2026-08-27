import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { EnvironmentSummary } from "./EnvironmentSummary.js";

describe("EnvironmentSummary", () => {
  it("labels the source and target connections and shows their environment badges", () => {
    render(
      <EnvironmentSummary
        connections={[
          { id: "s", type: "org", nickname: "DevSpare", createdAt: "", lastUsedAt: null, orgType: "production" },
          { id: "t", type: "org", nickname: "EffDevTest", createdAt: "", lastUsedAt: null, orgType: "sandbox" },
        ]}
        sourceId="s"
        targetId="t"
      />
    );

    expect(screen.getByText("Source")).toBeInTheDocument();
    expect(screen.getByText("Target")).toBeInTheDocument();
    expect(screen.getByText("DevSpare")).toBeInTheDocument();
    expect(screen.getByText("EffDevTest")).toBeInTheDocument();
    expect(screen.getByText("Production")).toBeInTheDocument();
    expect(screen.getByText("Sandbox")).toBeInTheDocument();
  });

  it("shows a GitHub icon for a git connection and a Salesforce icon for an org connection", () => {
    const { container } = render(
      <EnvironmentSummary
        connections={[
          { id: "s", type: "org", nickname: "Dev", createdAt: "", lastUsedAt: null, orgType: "sandbox" },
          { id: "t", type: "git", nickname: "Repo", createdAt: "", lastUsedAt: null },
        ]}
        sourceId="s"
        targetId="t"
      />
    );

    const items = container.querySelectorAll(".env-card-item");
    expect(items[0].querySelector("path[fill='#00A1E0']")).toBeInTheDocument();
    expect(items[1].querySelector("svg[fill='currentColor']")).toBeInTheDocument();
  });
});
