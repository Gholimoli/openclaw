import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { OfficeProps } from "./office.ts";
import { renderOffice } from "./office.ts";

function createProps(overrides: Partial<OfficeProps> = {}): OfficeProps {
  return {
    loading: false,
    error: null,
    savingLayout: false,
    evolutionStatus: {
      enabled: true,
      running: true,
      paused: false,
      objective: "reliability_quality",
      scoutEveryMs: 3_600_000,
      synthEveryMs: 86_400_000,
      nextScoutAtMs: null,
      nextSynthAtMs: null,
      lastScoutAtMs: null,
      lastSynthAtMs: null,
      counts: {
        sources: 1,
        insights: 2,
        proposals: 1,
        pending: 1,
        autoMergeCandidates: 1,
      },
    },
    proposals: [
      {
        id: "p-1",
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        title: "Improve docs reliability guidance",
        summary: "docs update",
        insightIds: [],
        sourceIds: ["github/openclaw/openclaw"],
        candidatePaths: ["docs/testing.md"],
        score: {
          reliabilityImpact: 90,
          qualityImpact: 88,
          implementationRisk: 12,
          effort: 14,
          sourceConfidence: 90,
          fitWithOpenClawArchitecture: 92,
          total: 86,
        },
        class: "auto_merge_low_risk",
        status: "pending",
      },
    ],
    agents: [
      {
        id: "main",
        label: "Main",
        state: "typing",
        lastUpdateMs: Date.now(),
        x: 2,
        y: 3,
      },
    ],
    layout: {
      version: 1,
      tileSize: 16,
      width: 32,
      height: 18,
      placements: { main: { x: 2, y: 3 } },
    },
    activity: [
      {
        id: "a-1",
        ts: Date.now(),
        kind: "agent.tool",
        label: "Main: running command",
      },
    ],
    filters: {
      agent: "",
      source: "",
      proposal: "",
      runClass: "all",
    },
    onRefresh: () => undefined,
    onTogglePause: () => undefined,
    onProposalAction: () => undefined,
    onFiltersChange: () => undefined,
    onMoveAgent: () => undefined,
    onSaveLayout: () => undefined,
    ...overrides,
  };
}

describe("office view", () => {
  it("renders office content and proposal actions", () => {
    const container = document.createElement("div");
    const onProposalAction = vi.fn();
    render(
      renderOffice(
        createProps({
          onProposalAction,
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Evolution Office");
    expect(container.textContent).toContain("Improve docs reliability guidance");

    const executeButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Execute",
    );
    expect(executeButton).not.toBeUndefined();
    executeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onProposalAction).toHaveBeenCalledWith("p-1", "execute");
  });

  it("emits filter updates from filter controls", () => {
    const container = document.createElement("div");
    const onFiltersChange = vi.fn();
    render(
      renderOffice(
        createProps({
          onFiltersChange,
        }),
      ),
      container,
    );

    const selects = container.querySelectorAll("select");
    const classSelect = selects[3] as HTMLSelectElement | undefined;
    expect(classSelect).toBeDefined();
    if (!classSelect) {
      return;
    }
    classSelect.value = "needs_review";
    classSelect.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onFiltersChange).toHaveBeenCalledWith({ runClass: "needs_review" });
  });
});
