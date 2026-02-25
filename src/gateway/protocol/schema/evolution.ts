import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

const SourceIncludeSchema = Type.Union([
  Type.Literal("releases"),
  Type.Literal("commits"),
  Type.Literal("issues"),
  Type.Literal("prs"),
]);

const SourceReliabilitySchema = Type.Union([
  Type.Literal("high"),
  Type.Literal("medium"),
  Type.Literal("low"),
]);

export const EvolutionSourceSpecSchema = Type.Object(
  {
    id: NonEmptyString,
    kind: Type.Union([Type.Literal("github_repo"), Type.Literal("manual_url")]),
    enabled: Type.Optional(Type.Boolean()),
    url: Type.Optional(Type.String()),
    githubOwner: Type.Optional(Type.String()),
    githubRepo: Type.Optional(Type.String()),
    include: Type.Optional(Type.Array(SourceIncludeSchema)),
    tags: Type.Optional(Type.Array(Type.String())),
    reliabilityTier: Type.Optional(SourceReliabilitySchema),
  },
  { additionalProperties: false },
);

export const EvolutionManualInsightSeedSchema = Type.Object(
  {
    evidenceText: NonEmptyString,
    url: Type.Optional(Type.String()),
    author: Type.Optional(Type.String()),
    publishedAt: Type.Optional(Type.String()),
    tags: Type.Optional(Type.Array(Type.String())),
    confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  },
  { additionalProperties: false },
);

export const EvolutionSourceSchema = Type.Object(
  {
    id: NonEmptyString,
    kind: Type.Union([Type.Literal("github_repo"), Type.Literal("manual_url")]),
    enabled: Type.Boolean(),
    url: Type.Optional(Type.String()),
    githubOwner: Type.Optional(Type.String()),
    githubRepo: Type.Optional(Type.String()),
    include: Type.Array(SourceIncludeSchema),
    tags: Type.Array(Type.String()),
    reliabilityTier: SourceReliabilitySchema,
    createdAtMs: Type.Integer({ minimum: 0 }),
    updatedAtMs: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const EvolutionInsightSchema = Type.Object(
  {
    id: NonEmptyString,
    sourceId: NonEmptyString,
    fetchedAt: NonEmptyString,
    url: NonEmptyString,
    author: Type.Optional(Type.String()),
    publishedAt: Type.Optional(Type.String()),
    contentHash: NonEmptyString,
    evidenceText: Type.String(),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    tags: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

const EvolutionProposalScoreSchema = Type.Object(
  {
    reliabilityImpact: Type.Integer({ minimum: 0, maximum: 100 }),
    qualityImpact: Type.Integer({ minimum: 0, maximum: 100 }),
    implementationRisk: Type.Integer({ minimum: 0, maximum: 100 }),
    effort: Type.Integer({ minimum: 0, maximum: 100 }),
    sourceConfidence: Type.Integer({ minimum: 0, maximum: 100 }),
    fitWithOpenClawArchitecture: Type.Integer({ minimum: 0, maximum: 100 }),
    total: Type.Integer({ minimum: 0, maximum: 100 }),
  },
  { additionalProperties: false },
);

const EvolutionPatchOperationSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal("replace_text"),
      path: NonEmptyString,
      find: Type.String(),
      replace: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("write_file"),
      path: NonEmptyString,
      content: Type.String(),
    },
    { additionalProperties: false },
  ),
]);

export const EvolutionProposalSchema = Type.Object(
  {
    id: NonEmptyString,
    createdAtMs: Type.Integer({ minimum: 0 }),
    updatedAtMs: Type.Integer({ minimum: 0 }),
    title: NonEmptyString,
    summary: Type.String(),
    insightIds: Type.Array(NonEmptyString),
    sourceIds: Type.Array(NonEmptyString),
    candidatePaths: Type.Array(NonEmptyString),
    score: EvolutionProposalScoreSchema,
    class: Type.Union([
      Type.Literal("auto_merge_low_risk"),
      Type.Literal("needs_review"),
      Type.Literal("reject_archive"),
    ]),
    status: Type.Union([
      Type.Literal("pending"),
      Type.Literal("approved"),
      Type.Literal("rejected"),
      Type.Literal("executing"),
      Type.Literal("executed"),
      Type.Literal("failed"),
      Type.Literal("archived"),
    ]),
    reason: Type.Optional(Type.String()),
    patchOps: Type.Optional(Type.Array(EvolutionPatchOperationSchema)),
    lastExecution: Type.Optional(
      Type.Object(
        {
          atMs: Type.Integer({ minimum: 0 }),
          ok: Type.Boolean(),
          commitSha: Type.Optional(Type.String()),
          message: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const EvolutionStatusSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    running: Type.Boolean(),
    paused: Type.Boolean(),
    objective: Type.Union([
      Type.Literal("reliability_quality"),
      Type.Literal("speed"),
      Type.Literal("cost"),
    ]),
    scoutEveryMs: Type.Integer({ minimum: 1 }),
    synthEveryMs: Type.Integer({ minimum: 1 }),
    nextScoutAtMs: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    nextSynthAtMs: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    lastScoutAtMs: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    lastSynthAtMs: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    counts: Type.Object(
      {
        sources: Type.Integer({ minimum: 0 }),
        insights: Type.Integer({ minimum: 0 }),
        proposals: Type.Integer({ minimum: 0 }),
        pending: Type.Integer({ minimum: 0 }),
        autoMergeCandidates: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const EvolutionStatusParamsSchema = Type.Object({}, { additionalProperties: false });

export const EvolutionSourcesListParamsSchema = Type.Object({}, { additionalProperties: false });

export const EvolutionSourcesUpsertParamsSchema = Type.Object(
  {
    source: EvolutionSourceSpecSchema,
    manualInsight: Type.Optional(EvolutionManualInsightSeedSchema),
  },
  { additionalProperties: false },
);

export const EvolutionInsightsListParamsSchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000 })),
  },
  { additionalProperties: false },
);

export const EvolutionProposalsListParamsSchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000 })),
  },
  { additionalProperties: false },
);

export const EvolutionProposalsActParamsSchema = Type.Object(
  {
    proposalId: Type.Optional(NonEmptyString),
    action: Type.Union([
      Type.Literal("approve"),
      Type.Literal("reject"),
      Type.Literal("execute"),
      Type.Literal("pause"),
    ]),
    paused: Type.Optional(Type.Boolean()),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const EvolutionSourcesListResultSchema = Type.Object(
  {
    sources: Type.Array(EvolutionSourceSchema),
  },
  { additionalProperties: false },
);

export const EvolutionInsightsListResultSchema = Type.Object(
  {
    insights: Type.Array(EvolutionInsightSchema),
  },
  { additionalProperties: false },
);

export const EvolutionProposalsListResultSchema = Type.Object(
  {
    proposals: Type.Array(EvolutionProposalSchema),
  },
  { additionalProperties: false },
);

export const EvolutionProposalsActResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    message: Type.String(),
  },
  { additionalProperties: false },
);
