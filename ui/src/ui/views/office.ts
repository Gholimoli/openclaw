import { html, nothing } from "lit";
import type {
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
  source: string;
  proposal: string;
  runClass: (typeof CLASS_OPTIONS)[number];
};

export type OfficeProps = {
  loading: boolean;
  error: string | null;
  savingLayout: boolean;
  evolutionStatus: EvolutionStatus | null;
  proposals: EvolutionProposal[];
  agents: OfficeAgentState[];
  layout: OfficeLayout | null;
  activity: OfficeActivityEntry[];
  filters: OfficeFilters;
  onRefresh: () => void;
  onTogglePause: () => void;
  onProposalAction: (
    proposalId: string,
    action: "approve" | "reject" | "execute",
  ) => void | Promise<void>;
  onFiltersChange: (patch: Partial<OfficeFilters>) => void;
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

  return html`
    <section class="card office-card">
      <div class="row office-toolbar">
        <div>
          <div class="card-title">Evolution Office</div>
          <div class="card-sub">
            Live agent states with reliability-first proposal execution controls.
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
