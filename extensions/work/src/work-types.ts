export type WorkEnvelope =
  | {
      ok: true;
      status: "ok" | "needs_approval" | "cancelled";
      output: unknown[];
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
