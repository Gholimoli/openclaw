import { html, nothing } from "lit";
import type { ExecApprovalRequest } from "../controllers/exec-approval.ts";
import type {
  AutomationAuditEntry,
  AutomationRun,
  AutomationStep,
  EvolutionProposal,
  EvolutionStatus,
  OfficeActivityEntry,
  OfficeAgentState,
  OfficeLayout,
} from "../types.ts";
import { formatMs } from "../format.ts";

const CLASS_OPTIONS = ["all", "auto_merge_low_risk", "needs_review", "reject_archive"] as const;

export type OfficeFilters = {
  agent: string;
  repo: string;
  status: string;
  dateFrom: string;
  dateTo: string;
  source: string;
  proposal: string;
  runClass: (typeof CLASS_OPTIONS)[number];
};

export type OfficeProps = {
  loading: boolean;
  error: string | null;
  savingLayout: boolean;
  evolutionStatus: EvolutionStatus | null;
  automationRuns: AutomationRun[];
  approvals: ExecApprovalRequest[];
  proposals: EvolutionProposal[];
  agents: OfficeAgentState[];
  layout: OfficeLayout | null;
  activity: OfficeActivityEntry[];
  filters: OfficeFilters;
  selectedRunId: string | null;
  selectedRunLoading: boolean;
  selectedRunError: string | null;
  selectedRun: AutomationRun | null;
  selectedRunSteps: AutomationStep[];
  selectedRunAudit: AutomationAuditEntry[];
  onRefresh: () => void;
  onTogglePause: () => void;
  onProposalAction: (
    proposalId: string,
    action: "approve" | "reject" | "execute",
  ) => void | Promise<void>;
  onFiltersChange: (patch: Partial<OfficeFilters>) => void;
  onSelectRun: (runId: string) => void | Promise<void>;
  onResumeRun: (runId: string) => void | Promise<void>;
  onCancelRun: (runId: string, reason?: string) => void | Promise<void>;
  onMoveAgent: (agentId: string, x: number, y: number) => void;
  onSaveLayout: () => void;
};

function classLabel(value: EvolutionProposal["class"]) {
  if (value === "auto_merge_low_risk") {
    return "Auto Merge";
  }
  if (value === "needs_review") {
    return "Needs Review";
  }
  return "Reject";
}

function spriteClass(state: OfficeAgentState["state"]) {
  return `office-sprite office-sprite--${state}`;
}

function normalizeFilter(value: string) {
  return value.trim().toLowerCase();
}

function parseDateFloor(value: string) {
  if (!value.trim()) {
    return null;
  }
  const parsed = Date.parse(`${value}T00:00:00`);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDateCeil(value: string) {
  if (!value.trim()) {
    return null;
  }
  const parsed = Date.parse(`${value}T23:59:59.999`);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatTimestamp(ts: number) {
  return new Date(ts).toLocaleString();
}

function toTilePlacement(
  event: DragEvent,
  layout: OfficeLayout,
  container: HTMLElement,
): { x: number; y: number } {
  const bounds = container.getBoundingClientRect();
  const tileSize = Math.max(1, layout.tileSize);
  const scaleX = bounds.width / (layout.width * tileSize);
  const scaleY = bounds.height / (layout.height * tileSize);
  const x = Math.floor((event.clientX - bounds.left) / Math.max(1, tileSize * scaleX));
  const y = Math.floor((event.clientY - bounds.top) / Math.max(1, tileSize * scaleY));
  return {
    x: Math.max(0, Math.min(layout.width - 1, x)),
    y: Math.max(0, Math.min(layout.height - 1, y)),
  };
}

export function renderOffice(props: OfficeProps) {
  const layout = props.layout;
  const repoFilter = normalizeFilter(props.filters.repo);
  const statusFilter = normalizeFilter(props.filters.status);
  const dateFloor = parseDateFloor(props.filters.dateFrom);
  const dateCeil = parseDateCeil(props.filters.dateTo);
  const sourceIds = Array.from(
    new Set(props.proposals.flatMap((entry) => entry.sourceIds)),
  ).toSorted();
  const filteredProposals = props.proposals.filter((proposal) => {
    if (props.filters.runClass !== "all" && proposal.class !== props.filters.runClass) {
      return false;
    }
    if (props.filters.source && !proposal.sourceIds.includes(props.filters.source)) {
      return false;
    }
    if (props.filters.proposal && proposal.id !== props.filters.proposal) {
      return false;
    }
    return true;
  });
  const filteredAgents = props.filters.agent
    ? props.agents.filter((entry) => entry.id === props.filters.agent)
    : props.agents;
  const recentActivity = props.activity
    .filter((entry) => {
      if (props.filters.agent && entry.agentId !== props.filters.agent) {
        return false;
      }
      if (props.filters.source && entry.sourceId !== props.filters.source) {
        return false;
      }
      if (props.filters.proposal && entry.proposalId !== props.filters.proposal) {
        return false;
      }
      return true;
    })
    .slice(-40)
    .toReversed();
  const filteredRuns = props.automationRuns.filter((run) => {
    if (repoFilter && !run.repo.toLowerCase().includes(repoFilter)) {
      return false;
    }
    if (statusFilter && run.status !== statusFilter) {
      return false;
    }
    if (
      props.filters.agent &&
      run.plannerAgentId !== props.filters.agent &&
      run.implementationAgentId !== props.filters.agent
    ) {
      return false;
    }
    if (dateFloor != null && run.updatedAtMs < dateFloor) {
      return false;
    }
    if (dateCeil != null && run.updatedAtMs > dateCeil) {
      return false;
    }
    return true;
  });
  const selectedRun =
    (props.selectedRun && filteredRuns.find((entry) => entry.id === props.selectedRun?.id)) ??
    filteredRuns[0] ??
    null;
  const selectedRunId = selectedRun?.id ?? props.selectedRunId;
  const selectedRunSteps = selectedRun?.id === props.selectedRun?.id ? props.selectedRunSteps : [];
  const selectedRunAudit = selectedRun?.id === props.selectedRun?.id ? props.selectedRunAudit : [];

  return html`
    <section class="card office-card">
      <div class="row office-toolbar">
        <div>
          <div class="card-title">Evolution Office</div>
          <div class="card-sub">
            Live agent states, approvals, and AI delivery runs.
          </div>
        </div>
        <div class="office-toolbar__actions">
          <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${props.loading ? "Refreshing..." : "Refresh"}
          </button>
          <button
            class="btn"
            ?disabled=${!props.evolutionStatus}
            @click=${() => {
              props.onTogglePause();
            }}
          >
            ${props.evolutionStatus?.paused ? "Resume Evolution" : "Pause Evolution"}
          </button>
          <button class="btn primary" ?disabled=${props.savingLayout || !layout} @click=${props.onSaveLayout}>
            ${props.savingLayout ? "Saving..." : "Save Layout"}
          </button>
        </div>
      </div>

      ${props.error ? html`<div class="callout danger office-error">${props.error}</div>` : nothing}

      ${
        props.evolutionStatus
          ? html`
              <div class="office-stats">
                <div class="stat">
                  <div class="stat-label">Paused</div>
                  <div class="stat-value ${props.evolutionStatus.paused ? "warn" : "ok"}">
                    ${props.evolutionStatus.paused ? "Yes" : "No"}
                  </div>
                </div>
                <div class="stat">
                  <div class="stat-label">Pending Proposals</div>
                  <div class="stat-value">${props.evolutionStatus.counts.pending}</div>
                </div>
                <div class="stat">
                  <div class="stat-label">Auto Merge Candidates</div>
                  <div class="stat-value">${props.evolutionStatus.counts.autoMergeCandidates}</div>
                </div>
                <div class="stat">
                  <div class="stat-label">Insights</div>
                  <div class="stat-value">${props.evolutionStatus.counts.insights}</div>
                </div>
                <div class="stat">
                  <div class="stat-label">Active Approvals</div>
                  <div class="stat-value">${props.approvals.length}</div>
                </div>
              </div>
            `
          : nothing
      }

      <div class="office-filters">
        <label class="field">
          <span>Agent</span>
          <select
            .value=${props.filters.agent}
            @change=${(event: Event) => {
              const value = (event.currentTarget as HTMLSelectElement).value;
              props.onFiltersChange({ agent: value });
            }}
          >
            <option value="">All agents</option>
            ${props.agents.map((agent) => html`<option value=${agent.id}>${agent.label}</option>`)}
          </select>
        </label>
        <label class="field">
          <span>Repo</span>
          <input
            .value=${props.filters.repo}
            placeholder="owner/repo"
            @input=${(event: Event) => {
              const value = (event.currentTarget as HTMLInputElement).value;
              props.onFiltersChange({ repo: value });
            }}
          />
        </label>
        <label class="field">
          <span>Run Status</span>
          <select
            .value=${props.filters.status}
            @change=${(event: Event) => {
              const value = (event.currentTarget as HTMLSelectElement).value;
              props.onFiltersChange({ status: value });
            }}
          >
            <option value="">All statuses</option>
            ${[
              "queued",
              "planning",
              "running",
              "awaiting_approval",
              "completed",
              "failed",
              "cancelled",
            ].map((value) => html`<option value=${value}>${value}</option>`)}
          </select>
        </label>
        <label class="field">
          <span>Updated From</span>
          <input
            type="date"
            .value=${props.filters.dateFrom}
            @change=${(event: Event) => {
              const value = (event.currentTarget as HTMLInputElement).value;
              props.onFiltersChange({ dateFrom: value });
            }}
          />
        </label>
        <label class="field">
          <span>Updated To</span>
          <input
            type="date"
            .value=${props.filters.dateTo}
            @change=${(event: Event) => {
              const value = (event.currentTarget as HTMLInputElement).value;
              props.onFiltersChange({ dateTo: value });
            }}
          />
        </label>
        <label class="field">
          <span>Source</span>
          <select
            .value=${props.filters.source}
            @change=${(event: Event) => {
              const value = (event.currentTarget as HTMLSelectElement).value;
              props.onFiltersChange({ source: value });
            }}
          >
            <option value="">All sources</option>
            ${sourceIds.map((sourceId) => html`<option value=${sourceId}>${sourceId}</option>`)}
          </select>
        </label>
        <label class="field">
          <span>Proposal</span>
          <select
            .value=${props.filters.proposal}
            @change=${(event: Event) => {
              const value = (event.currentTarget as HTMLSelectElement).value;
              props.onFiltersChange({ proposal: value });
            }}
          >
            <option value="">All proposals</option>
            ${props.proposals.map(
              (proposal) =>
                html`<option value=${proposal.id}>${proposal.id.slice(0, 8)} - ${proposal.title}</option>`,
            )}
          </select>
        </label>
        <label class="field">
          <span>Run Class</span>
          <select
            .value=${props.filters.runClass}
            @change=${(event: Event) => {
              const value = (event.currentTarget as HTMLSelectElement)
                .value as OfficeFilters["runClass"];
              props.onFiltersChange({ runClass: value });
            }}
          >
            ${CLASS_OPTIONS.map(
              (value) => html`<option value=${value}>${value === "all" ? "All" : value}</option>`,
            )}
          </select>
        </label>
      </div>

      <div class="office-grid">
        <section class="office-panel">
          <div class="office-panel__title">AI Delivery Runs</div>
          ${
            filteredRuns.length === 0
              ? html`
                  <div class="muted">No automation runs recorded yet.</div>
                `
              : html`
                  <div class="office-run-list">
                    ${filteredRuns.slice(0, 20).map(
                      (run) => html`
                        <article
                          class=${`office-run ${selectedRunId === run.id ? "office-run--active" : ""}`}
                          @click=${() => props.onSelectRun(run.id)}
                        >
                          <div class="office-run__header">
                            <strong>${run.repo}</strong>
                            <span class="pill ${run.status}">${run.status}</span>
                          </div>
                          <div class="office-run__title">${run.title}</div>
                          <div class="office-run__meta">
                            ${run.specPacket.planner.displayName ?? run.plannerAgentId}
                            /
                            ${run.implementationCli}
                            ${run.implementationModel ? `(${run.implementationModel})` : ""}
                          </div>
                          <div class="office-run__meta">
                            ${run.branch ?? run.base} · ${run.riskTier} risk · updated
                            ${formatMs(Math.max(0, Date.now() - run.updatedAtMs))} ago
                          </div>
                          ${
                            run.summary
                              ? html`<div class="office-run__summary">${run.summary}</div>`
                              : nothing
                          }
                        </article>
                      `,
                    )}
                  </div>
                `
          }
        </section>

        <section class="office-panel">
          <div class="office-panel__title">Run Detail</div>
          ${props.selectedRunError ? html`<div class="callout danger">${props.selectedRunError}</div>` : nothing}
          ${
            !selectedRun
              ? html`
                  <div class="muted">Select a run to inspect its timeline and audit trail.</div>
                `
              : html`
                  <div class="office-detail">
                    <div class="office-detail__header">
                      <div>
                        <div class="office-run__title">${selectedRun.title}</div>
                        <div class="office-run__meta">
                          ${selectedRun.repo} · ${selectedRun.branch ?? selectedRun.base} ·
                          ${selectedRun.riskTier} risk
                        </div>
                      </div>
                      <span class="pill ${selectedRun.status}">${selectedRun.status}</span>
                    </div>
                    <div class="office-detail__meta">
                      <span class="chip">
                        Ted: ${selectedRun.specPacket.planner.displayName ?? selectedRun.plannerAgentId}
                      </span>
                      <span class="chip">
                        CLI: ${selectedRun.implementationUsedCli ?? selectedRun.implementationCli}
                      </span>
                      ${
                        selectedRun.specPacket.implementation.authMode
                          ? html`<span class="chip">
                              Auth: ${selectedRun.specPacket.implementation.authMode}
                            </span>`
                          : nothing
                      }
                    </div>
                    <div class="office-run__summary">
                      ${selectedRun.summary ?? selectedRun.userRequest}
                    </div>
                    <div class="office-proposal__actions">
                      <button
                        class="btn"
                        ?disabled=${
                          props.selectedRunLoading ||
                          selectedRun.status === "running" ||
                          selectedRun.status === "planning" ||
                          selectedRun.status === "queued"
                        }
                        @click=${() => props.onResumeRun(selectedRun.id)}
                      >
                        ${props.selectedRunLoading ? "Refreshing..." : "Resume"}
                      </button>
                      <button
                        class="btn"
                        ?disabled=${
                          props.selectedRunLoading ||
                          selectedRun.status === "completed" ||
                          selectedRun.status === "failed" ||
                          selectedRun.status === "cancelled"
                        }
                        @click=${() => {
                          const reason = window.prompt(
                            "Cancel reason",
                            "Run cancelled from Control UI",
                          );
                          if (reason === null) {
                            return;
                          }
                          void props.onCancelRun(selectedRun.id, reason.trim() || undefined);
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                    <div class="office-detail__section">
                      <div class="card-sub">Approval Queue</div>
                      ${
                        props.approvals.length === 0
                          ? html`
                              <div class="muted">No pending approvals.</div>
                            `
                          : html`
                              <div class="office-run-list office-run-list--compact">
                                ${props.approvals.slice(0, 6).map(
                                  (approval) => html`
                                    <article class="office-run">
                                      <div class="office-run__header">
                                        <strong>${approval.request.agentId ?? "agent"}</strong>
                                        <span class="pill warn">approval</span>
                                      </div>
                                      <div class="office-run__title">${approval.request.command}</div>
                                      <div class="office-run__meta">
                                        expires in
                                        ${formatMs(Math.max(0, approval.expiresAtMs - Date.now()))}
                                      </div>
                                    </article>
                                  `,
                                )}
                              </div>
                            `
                      }
                    </div>
                    <div class="office-detail__section">
                      <div class="card-sub">Step Timeline</div>
                      ${
                        selectedRunSteps.length === 0
                          ? html`
                              <div class="muted">No step data recorded yet.</div>
                            `
                          : html`
                              <div class="office-detail__list">
                                ${selectedRunSteps.slice(0, 12).map(
                                  (step) => html`
                                    <div class="office-detail__item">
                                      <div class="office-run__header">
                                        <strong>${step.label}</strong>
                                        <span class="pill ${step.status}">${step.status}</span>
                                      </div>
                                      <div class="office-run__meta">
                                        ${formatTimestamp(step.ts)}
                                        ${step.actor?.label ? `· ${step.actor.label}` : ""}
                                        ${
                                          typeof step.exitCode === "number"
                                            ? `· exit ${step.exitCode}`
                                            : ""
                                        }
                                      </div>
                                      ${
                                        step.detail
                                          ? html`<div class="office-run__summary">${step.detail}</div>`
                                          : nothing
                                      }
                                    </div>
                                  `,
                                )}
                              </div>
                            `
                      }
                    </div>
                    <div class="office-detail__section">
                      <div class="card-sub">Audit Trail</div>
                      ${
                        selectedRunAudit.length === 0
                          ? html`
                              <div class="muted">No audit records recorded yet.</div>
                            `
                          : html`
                              <div class="office-detail__list">
                                ${selectedRunAudit.slice(0, 12).map(
                                  (entry) => html`
                                    <div class="office-detail__item">
                                      <div class="office-run__header">
                                        <strong>${entry.kind}</strong>
                                        ${
                                          entry.status
                                            ? html`<span class="pill ${entry.status}">${entry.status}</span>`
                                            : nothing
                                        }
                                      </div>
                                      <div class="office-run__meta">
                                        ${formatTimestamp(entry.ts)}
                                        ${entry.actor?.label ? `· ${entry.actor.label}` : ""}
                                      </div>
                                      <div class="office-run__summary">${entry.message}</div>
                                    </div>
                                  `,
                                )}
                              </div>
                            `
                      }
                    </div>
                  </div>
                `
          }
        </section>
      </div>

      <div class="office-grid">
        <section class="office-map-wrap">
          ${
            !layout
              ? html`
                  <div class="muted">No office layout available.</div>
                `
              : html`
                  <div
                    class="office-map"
                    style=${`--office-cols:${layout.width}; --office-rows:${layout.height}; --office-tile:${layout.tileSize}px;`}
                    @dragover=${(event: DragEvent) => {
                      event.preventDefault();
                    }}
                    @drop=${(event: DragEvent) => {
                      event.preventDefault();
                      const data = event.dataTransfer?.getData("text/office-agent") ?? "";
                      if (!data) {
                        return;
                      }
                      const target = event.currentTarget;
                      if (!(target instanceof HTMLElement)) {
                        return;
                      }
                      const next = toTilePlacement(event, layout, target);
                      props.onMoveAgent(data, next.x, next.y);
                    }}
                  >
                    ${filteredAgents.map((agent) => {
                      const placement = layout.placements[agent.id] ?? { x: agent.x, y: agent.y };
                      return html`
                        <div
                          class=${spriteClass(agent.state)}
                          style=${`left: calc(${placement.x} * var(--office-tile) * var(--office-scale)); top: calc(${placement.y} * var(--office-tile) * var(--office-scale));`}
                          draggable="true"
                          title=${`${agent.label} - ${agent.state}${agent.details ? ` (${agent.details})` : ""}`}
                          @dragstart=${(event: DragEvent) => {
                            const transfer = event.dataTransfer;
                            if (!transfer) {
                              return;
                            }
                            transfer.setData("text/office-agent", agent.id);
                            transfer.effectAllowed = "move";
                          }}
                        >
                          <div class="office-sprite__body"></div>
                          ${
                            agent.blocked || agent.failed
                              ? html`<div class="office-bubble">${agent.failed ? "Failed" : "Blocked"}</div>`
                              : nothing
                          }
                          <div class="office-sprite__name">${agent.label}</div>
                        </div>
                      `;
                    })}
                  </div>
                `
          }
        </section>

        <section class="office-panel">
          <div class="card-title">Proposals</div>
          <div class="office-proposals">
            ${
              filteredProposals.length === 0
                ? html`
                    <div class="muted">No proposals for current filters.</div>
                  `
                : filteredProposals.slice(0, 12).map(
                    (proposal) => html`
                      <article class="office-proposal">
                        <div class="office-proposal__title">${proposal.title}</div>
                        <div class="office-proposal__meta">
                          <span class="chip">${classLabel(proposal.class)}</span>
                          <span class="chip">Score ${proposal.score.total}</span>
                          <span class="chip">${proposal.status}</span>
                        </div>
                        <div class="office-proposal__actions">
                          <button
                            class="btn"
                            ?disabled=${proposal.status === "executing"}
                            @click=${() => props.onProposalAction(proposal.id, "execute")}
                          >
                            Execute
                          </button>
                          <button class="btn" @click=${() => props.onProposalAction(proposal.id, "approve")}>
                            Approve
                          </button>
                          <button class="btn" @click=${() => props.onProposalAction(proposal.id, "reject")}>
                            Reject
                          </button>
                        </div>
                      </article>
                    `,
                  )
            }
          </div>
          <div class="card-title office-panel__title">Activity</div>
          <div class="office-activity">
            ${
              recentActivity.length === 0
                ? html`
                    <div class="muted">No activity yet.</div>
                  `
                : recentActivity.map(
                    (entry) => html`
                      <div class="office-activity__entry" title=${entry.details ?? ""}>
                        <div class="office-activity__label">${entry.label}</div>
                        <div class="office-activity__meta">
                          ${formatMs(entry.ts)} ${entry.kind}
                        </div>
                      </div>
                    `,
                  )
            }
          </div>
        </section>
      </div>
    </section>
  `;
}
