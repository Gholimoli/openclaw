export type AutomationRiskTier = "low" | "medium" | "high";

export type AutomationRunStatus =
  | "queued"
  | "planning"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type AutomationActorType = "agent" | "tool" | "human" | "system" | "github-app";

export type AutomationActor = {
  id: string;
  type: AutomationActorType;
  label?: string;
};

export type AutomationSpecPacket = {
  repo: string;
  repoUrl?: string;
  repoDir?: string;
  base: string;
  branch?: string;
  defaultBranch?: string;
  userRequest: string;
  goal: string;
  nonGoals: string[];
  acceptanceCriteria: string[];
  riskTier: AutomationRiskTier;
  checks: string[];
  approvalRequirements: string[];
  activePrNumbers?: number[];
  planner: {
    agentId: string;
    displayName?: string;
    model?: string;
  };
  implementation: {
    agentId: string;
    primaryCli: "codex" | "gemini";
    fallbackCli?: "gemini";
    availableClis?: string[];
    accessMode?: "full-access";
    authMode?: "hybrid" | "oauth-first";
    model?: string;
    secondaryModel?: string;
    fallbackModel?: string;
  };
};

export type AutomationRun = {
  id: string;
  repo: string;
  repoUrl?: string;
  repoDir?: string;
  base: string;
  branch?: string;
  defaultBranch?: string;
  status: AutomationRunStatus;
  title: string;
  userRequest: string;
  riskTier: AutomationRiskTier;
  plannerAgentId: string;
  plannerDisplayName?: string;
  plannerModel?: string;
  implementationAgentId: string;
  implementationCli: "codex" | "gemini";
  implementationFallbackCli?: "gemini";
  implementationUsedCli?: "codex" | "gemini";
  implementationModel?: string;
  fallbackModel?: string;
  startedAtMs: number;
  updatedAtMs: number;
  finishedAtMs?: number;
  specPacket: AutomationSpecPacket;
  summary?: string;
  lastStepLabel?: string;
  lastApprovalId?: string;
};

export type AutomationStepStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "awaiting_approval"
  | "skipped";

export type AutomationStep = {
  id: string;
  runId: string;
  ts: number;
  status: AutomationStepStatus;
  label: string;
  detail?: string;
  actor?: AutomationActor;
  command?: string;
  exitCode?: number;
  data?: Record<string, unknown>;
};

export type AutomationAuditEntry = {
  id: string;
  runId?: string;
  ts: number;
  kind: string;
  status?: string;
  message: string;
  repo?: string;
  branch?: string;
  actor?: AutomationActor;
  data?: Record<string, unknown>;
};

export type AutomationApprovalEvent = {
  id: string;
  ts: number;
  runId?: string;
  approvalId: string;
  state: "requested" | "resolved";
  decision?: "allow-once" | "allow-always" | "deny";
  resolvedBy?: string;
  agentId?: string;
  sessionKey?: string;
  command?: string;
  host?: string;
  cwd?: string;
  security?: string;
  ask?: string;
};

export type AutomationRawEvent =
  | {
      kind: "run.upsert";
      ts: number;
      run: AutomationRun;
    }
  | {
      kind: "step.append";
      ts: number;
      step: AutomationStep;
    }
  | {
      kind: "audit.append";
      ts: number;
      entry: AutomationAuditEntry;
    }
  | {
      kind: "approval.event";
      ts: number;
      approval: AutomationApprovalEvent;
    };

export type AutomationEventPayload =
  | { kind: "run.updated"; run: AutomationRun }
  | { kind: "step.updated"; step: AutomationStep }
  | { kind: "approval.requested"; approval: AutomationApprovalEvent }
  | { kind: "approval.resolved"; approval: AutomationApprovalEvent };

export type AutomationQuery = {
  runId?: string;
  repo?: string;
  branch?: string;
  actorId?: string;
  kind?: string;
  limit?: number;
};
