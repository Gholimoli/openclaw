export type WorkSpecPacket = {
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
  riskTier: "low" | "medium" | "high";
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
    primaryCli: "codex";
    fallbackCli?: "gemini";
    model?: string;
    fallbackModel?: string;
  };
};

export type WorkEnvelope =
  | {
      ok: true;
      status: "ok" | "needs_approval" | "cancelled";
      output: unknown[];
      runId?: string;
      specPacket?: WorkSpecPacket;
      requiresApproval: null | {
        type: "approval_request";
        prompt: string;
        items: unknown[];
        resumeToken?: string;
      };
    }
  | {
      ok: false;
      error: { type?: string; message: string };
    };

export type WorkAction =
  | "new"
  | "task"
  | "review"
  | "fix"
  | "ship"
  | "merge"
  | "upstream"
  | "resume";
