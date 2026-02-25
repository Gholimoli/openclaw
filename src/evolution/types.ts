export type EvolutionSourceKind = "github_repo" | "manual_url";
export type EvolutionSourceInclude = "releases" | "commits" | "issues" | "prs";
export type EvolutionSourceReliabilityTier = "high" | "medium" | "low";

export type EvolutionSource = {
  id: string;
  kind: EvolutionSourceKind;
  enabled: boolean;
  url?: string;
  githubOwner?: string;
  githubRepo?: string;
  include: EvolutionSourceInclude[];
  tags: string[];
  reliabilityTier: EvolutionSourceReliabilityTier;
  createdAtMs: number;
  updatedAtMs: number;
};

export type EvolutionInsight = {
  id: string;
  sourceId: string;
  fetchedAt: string;
  url: string;
  author?: string;
  publishedAt?: string;
  contentHash: string;
  evidenceText: string;
  confidence: number;
  tags: string[];
};

export type EvolutionProposalClass = "auto_merge_low_risk" | "needs_review" | "reject_archive";

export type EvolutionProposalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "executing"
  | "executed"
  | "failed"
  | "archived";

export type EvolutionProposalScore = {
  reliabilityImpact: number;
  qualityImpact: number;
  implementationRisk: number;
  effort: number;
  sourceConfidence: number;
  fitWithOpenClawArchitecture: number;
  total: number;
};

export type EvolutionPatchOperation =
  | {
      type: "replace_text";
      path: string;
      find: string;
      replace: string;
    }
  | {
      type: "write_file";
      path: string;
      content: string;
    };

export type EvolutionProposal = {
  id: string;
  createdAtMs: number;
  updatedAtMs: number;
  title: string;
  summary: string;
  insightIds: string[];
  sourceIds: string[];
  candidatePaths: string[];
  score: EvolutionProposalScore;
  class: EvolutionProposalClass;
  status: EvolutionProposalStatus;
  reason?: string;
  patchOps?: EvolutionPatchOperation[];
  lastExecution?: {
    atMs: number;
    ok: boolean;
    commitSha?: string;
    message?: string;
  };
};

export type EvolutionRunStage = "scout" | "synthesize" | "execute" | "report";

export type EvolutionRun = {
  id: string;
  stage: EvolutionRunStage;
  startedAtMs: number;
  finishedAtMs?: number;
  ok?: boolean;
  message?: string;
  meta?: Record<string, unknown>;
};

export type EvolutionAuditEntry = {
  id: string;
  ts: number;
  proposalId: string;
  action: "execute" | "approve" | "reject" | "pause" | "resume";
  ok: boolean;
  message?: string;
  commitSha?: string;
  changedPaths?: string[];
  checks?: Array<{
    command: string;
    ok: boolean;
    durationMs: number;
    stderrTail?: string;
  }>;
};

export type OfficeVisualState =
  | "idle"
  | "walking"
  | "reading"
  | "typing"
  | "running-command"
  | "waiting-input"
  | "approval-blocked"
  | "failed";

export type OfficeAgentState = {
  id: string;
  label: string;
  state: OfficeVisualState;
  lastUpdateMs: number;
  runId?: string;
  details?: string;
  blocked?: boolean;
  failed?: boolean;
  x: number;
  y: number;
};

export type OfficeLayout = {
  version: 1;
  tileSize: number;
  width: number;
  height: number;
  placements: Record<
    string,
    {
      x: number;
      y: number;
    }
  >;
};

export type OfficeActivityEntry = {
  id: string;
  ts: number;
  kind: string;
  label: string;
  details?: string;
  agentId?: string;
  proposalId?: string;
  sourceId?: string;
  runId?: string;
};

export type EvolutionPauseState = {
  paused: boolean;
  reason?: string;
  updatedAtMs: number;
  consecutiveFailures: number;
  recentFailureTimestamps: number[];
};

export type EvolutionSourceCursor = {
  etag?: string;
  cursor?: string;
  fetchedAtMs?: number;
  lastMalformedCount?: number;
  lastMalformedAtMs?: number;
  malformedBurstCount?: number;
};

export type EvolutionSourceStore = {
  version: 1;
  sources: EvolutionSource[];
  cursors: Record<string, EvolutionSourceCursor>;
};

export type EvolutionStatus = {
  enabled: boolean;
  running: boolean;
  paused: boolean;
  objective: "reliability_quality" | "speed" | "cost";
  scoutEveryMs: number;
  synthEveryMs: number;
  nextScoutAtMs: number | null;
  nextSynthAtMs: number | null;
  lastScoutAtMs: number | null;
  lastSynthAtMs: number | null;
  counts: {
    sources: number;
    insights: number;
    proposals: number;
    pending: number;
    autoMergeCandidates: number;
  };
};

export type EvolutionReport = {
  id: string;
  ts: number;
  summary: string;
  stats: {
    insightsAdded: number;
    proposalsAdded: number;
    executed: number;
    failed: number;
  };
};

export type EvolutionEventPayload =
  | {
      kind: "run.started";
      run: EvolutionRun;
    }
  | {
      kind: "run.finished";
      run: EvolutionRun;
    }
  | {
      kind: "proposal.updated";
      proposal: EvolutionProposal;
    }
  | {
      kind: "paused.changed";
      paused: boolean;
      reason?: string;
    }
  | {
      kind: "report.published";
      report: EvolutionReport;
    };

export type OfficeEventPayload =
  | {
      kind: "agent.delta";
      agent: OfficeAgentState;
    }
  | {
      kind: "alert.pin";
      message: string;
      severity: "info" | "warn" | "error";
      agentId?: string;
      proposalId?: string;
    }
  | {
      kind: "layout.updated";
      layout: OfficeLayout;
    }
  | {
      kind: "activity.append";
      entry: OfficeActivityEntry;
    };

export type EvolutionProposalAction = "approve" | "reject" | "execute" | "pause";
