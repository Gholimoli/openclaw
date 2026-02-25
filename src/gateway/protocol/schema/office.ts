import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

export const OfficeAgentStateSchema = Type.Object(
  {
    id: NonEmptyString,
    label: NonEmptyString,
    state: Type.Union([
      Type.Literal("idle"),
      Type.Literal("walking"),
      Type.Literal("reading"),
      Type.Literal("typing"),
      Type.Literal("running-command"),
      Type.Literal("waiting-input"),
      Type.Literal("approval-blocked"),
      Type.Literal("failed"),
    ]),
    lastUpdateMs: Type.Integer({ minimum: 0 }),
    runId: Type.Optional(Type.String()),
    details: Type.Optional(Type.String()),
    blocked: Type.Optional(Type.Boolean()),
    failed: Type.Optional(Type.Boolean()),
    x: Type.Integer({ minimum: 0 }),
    y: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const OfficeLayoutSchema = Type.Object(
  {
    version: Type.Literal(1),
    tileSize: Type.Integer({ minimum: 1 }),
    width: Type.Integer({ minimum: 1 }),
    height: Type.Integer({ minimum: 1 }),
    placements: Type.Record(
      NonEmptyString,
      Type.Object(
        {
          x: Type.Integer({ minimum: 0 }),
          y: Type.Integer({ minimum: 0 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const OfficeActivityEntrySchema = Type.Object(
  {
    id: NonEmptyString,
    ts: Type.Integer({ minimum: 0 }),
    kind: NonEmptyString,
    label: NonEmptyString,
    details: Type.Optional(Type.String()),
    agentId: Type.Optional(Type.String()),
    proposalId: Type.Optional(Type.String()),
    sourceId: Type.Optional(Type.String()),
    runId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const OfficeSnapshotParamsSchema = Type.Object({}, { additionalProperties: false });
export const OfficeLayoutGetParamsSchema = Type.Object({}, { additionalProperties: false });

export const OfficeLayoutSetParamsSchema = Type.Object(
  {
    layout: OfficeLayoutSchema,
  },
  { additionalProperties: false },
);

export const OfficeSnapshotSchema = Type.Object(
  {
    agents: Type.Array(OfficeAgentStateSchema),
    layout: OfficeLayoutSchema,
    activity: Type.Array(OfficeActivityEntrySchema),
  },
  { additionalProperties: false },
);
