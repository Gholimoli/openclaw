import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

const AutomationRiskTierSchema = Type.Union([
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
]);

const AutomationRunStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("planning"),
  Type.Literal("running"),
  Type.Literal("awaiting_approval"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
]);

const AutomationActorTypeSchema = Type.Union([
  Type.Literal("agent"),
  Type.Literal("tool"),
  Type.Literal("human"),
  Type.Literal("system"),
  Type.Literal("github-app"),
]);

export const AutomationActorSchema = Type.Object(
  {
    id: NonEmptyString,
    type: AutomationActorTypeSchema,
    label: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const AutomationSpecPacketSchema = Type.Object(
  {
    repo: NonEmptyString,
    repoUrl: Type.Optional(Type.String()),
    repoDir: Type.Optional(Type.String()),
    base: NonEmptyString,
    branch: Type.Optional(Type.String()),
    defaultBranch: Type.Optional(Type.String()),
    userRequest: Type.String(),
    goal: Type.String(),
    nonGoals: Type.Array(Type.String()),
    acceptanceCriteria: Type.Array(Type.String()),
    riskTier: AutomationRiskTierSchema,
    checks: Type.Array(Type.String()),
    approvalRequirements: Type.Array(Type.String()),
    activePrNumbers: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }))),
    planner: Type.Object(
      {
        agentId: NonEmptyString,
        displayName: Type.Optional(Type.String()),
        model: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    implementation: Type.Object(
      {
        agentId: NonEmptyString,
        primaryCli: Type.Union([Type.Literal("codex"), Type.Literal("gemini")]),
        fallbackCli: Type.Optional(Type.Literal("gemini")),
        availableClis: Type.Optional(
          Type.Array(Type.Union([Type.Literal("codex"), Type.Literal("gemini")])),
        ),
        accessMode: Type.Optional(Type.Literal("full-access")),
        authMode: Type.Optional(Type.Literal("hybrid")),
        model: Type.Optional(Type.String()),
        fallbackModel: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const AutomationRunSchema = Type.Object(
  {
    id: NonEmptyString,
    repo: NonEmptyString,
    repoUrl: Type.Optional(Type.String()),
    repoDir: Type.Optional(Type.String()),
    base: NonEmptyString,
    branch: Type.Optional(Type.String()),
    defaultBranch: Type.Optional(Type.String()),
    status: AutomationRunStatusSchema,
    title: Type.String(),
    userRequest: Type.String(),
    riskTier: AutomationRiskTierSchema,
    plannerAgentId: NonEmptyString,
    plannerDisplayName: Type.Optional(Type.String()),
    plannerModel: Type.Optional(Type.String()),
    implementationAgentId: NonEmptyString,
    implementationCli: Type.Union([Type.Literal("codex"), Type.Literal("gemini")]),
    implementationFallbackCli: Type.Optional(Type.Literal("gemini")),
    implementationUsedCli: Type.Optional(
      Type.Union([Type.Literal("codex"), Type.Literal("gemini")]),
    ),
    implementationModel: Type.Optional(Type.String()),
    fallbackModel: Type.Optional(Type.String()),
    startedAtMs: Type.Integer({ minimum: 0 }),
    updatedAtMs: Type.Integer({ minimum: 0 }),
    finishedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    specPacket: AutomationSpecPacketSchema,
    summary: Type.Optional(Type.String()),
    lastStepLabel: Type.Optional(Type.String()),
    lastApprovalId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const AutomationStepSchema = Type.Object(
  {
    id: NonEmptyString,
    runId: NonEmptyString,
    ts: Type.Integer({ minimum: 0 }),
    status: Type.Union([
      Type.Literal("queued"),
      Type.Literal("running"),
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("awaiting_approval"),
      Type.Literal("skipped"),
    ]),
    label: Type.String(),
    detail: Type.Optional(Type.String()),
    actor: Type.Optional(AutomationActorSchema),
    command: Type.Optional(Type.String()),
    exitCode: Type.Optional(Type.Integer()),
    data: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

export const AutomationAuditEntrySchema = Type.Object(
  {
    id: NonEmptyString,
    runId: Type.Optional(Type.String()),
    ts: Type.Integer({ minimum: 0 }),
    kind: NonEmptyString,
    status: Type.Optional(Type.String()),
    message: Type.String(),
    repo: Type.Optional(Type.String()),
    branch: Type.Optional(Type.String()),
    actor: Type.Optional(AutomationActorSchema),
    data: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

export const AutomationApprovalEventSchema = Type.Object(
  {
    id: NonEmptyString,
    ts: Type.Integer({ minimum: 0 }),
    runId: Type.Optional(Type.String()),
    approvalId: NonEmptyString,
    state: Type.Union([Type.Literal("requested"), Type.Literal("resolved")]),
    decision: Type.Optional(
      Type.Union([Type.Literal("allow-once"), Type.Literal("allow-always"), Type.Literal("deny")]),
    ),
    resolvedBy: Type.Optional(Type.String()),
    agentId: Type.Optional(Type.String()),
    sessionKey: Type.Optional(Type.String()),
    command: Type.Optional(Type.String()),
    host: Type.Optional(Type.String()),
    cwd: Type.Optional(Type.String()),
    security: Type.Optional(Type.String()),
    ask: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const AutomationRunsListParamsSchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    repo: Type.Optional(Type.String()),
    status: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const AutomationRunsListResultSchema = Type.Object(
  {
    runs: Type.Array(AutomationRunSchema),
  },
  { additionalProperties: false },
);

export const AutomationRunsGetParamsSchema = Type.Object(
  {
    runId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const AutomationRunsGetResultSchema = Type.Object(
  {
    run: Type.Union([AutomationRunSchema, Type.Null()]),
    steps: Type.Array(AutomationStepSchema),
    audit: Type.Array(AutomationAuditEntrySchema),
  },
  { additionalProperties: false },
);

export const AutomationRunsResumeParamsSchema = Type.Object(
  {
    runId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const AutomationRunsResumeResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    run: Type.Union([AutomationRunSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

export const AutomationRunsCancelParamsSchema = Type.Object(
  {
    runId: NonEmptyString,
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const AutomationRunsCancelResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    run: Type.Union([AutomationRunSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

export const AutomationAuditQueryParamsSchema = Type.Object(
  {
    runId: Type.Optional(Type.String()),
    repo: Type.Optional(Type.String()),
    branch: Type.Optional(Type.String()),
    actorId: Type.Optional(Type.String()),
    kind: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  },
  { additionalProperties: false },
);

export const AutomationAuditQueryResultSchema = Type.Object(
  {
    entries: Type.Array(AutomationAuditEntrySchema),
  },
  { additionalProperties: false },
);
