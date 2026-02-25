import type { EvolutionSourceSpec } from "../../config/types.evolution.js";
import type { OfficeLayout } from "../../evolution/types.js";
import type { GatewayRequestHandlers } from "./types.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateEvolutionInsightsListParams,
  validateEvolutionProposalsActParams,
  validateEvolutionProposalsListParams,
  validateEvolutionSourcesListParams,
  validateEvolutionSourcesUpsertParams,
  validateEvolutionStatusParams,
  validateOfficeLayoutGetParams,
  validateOfficeLayoutSetParams,
  validateOfficeSnapshotParams,
} from "../protocol/index.js";

function evolutionUnavailableError() {
  return errorShape(ErrorCodes.UNAVAILABLE, "evolution service unavailable");
}

export const evolutionHandlers: GatewayRequestHandlers = {
  "evolution.status": async ({ params, respond, context }) => {
    if (!validateEvolutionStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid evolution.status params: ${formatValidationErrors(validateEvolutionStatusParams.errors)}`,
        ),
      );
      return;
    }
    if (!context.evolution) {
      respond(false, undefined, evolutionUnavailableError());
      return;
    }
    const status = await context.evolution.status();
    respond(true, status, undefined);
  },

  "evolution.sources.list": async ({ params, respond, context }) => {
    if (!validateEvolutionSourcesListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid evolution.sources.list params: ${formatValidationErrors(validateEvolutionSourcesListParams.errors)}`,
        ),
      );
      return;
    }
    if (!context.evolution) {
      respond(false, undefined, evolutionUnavailableError());
      return;
    }
    const sources = await context.evolution.listSources();
    respond(true, { sources }, undefined);
  },

  "evolution.sources.upsert": async ({ params, respond, context }) => {
    if (!validateEvolutionSourcesUpsertParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid evolution.sources.upsert params: ${formatValidationErrors(validateEvolutionSourcesUpsertParams.errors)}`,
        ),
      );
      return;
    }
    if (!context.evolution) {
      respond(false, undefined, evolutionUnavailableError());
      return;
    }
    const parsed = params as {
      source: EvolutionSourceSpec;
      manualInsight?: {
        evidenceText: string;
        url?: string;
        author?: string;
        publishedAt?: string;
        tags?: string[];
        confidence?: number;
      };
    };
    const source = await context.evolution.upsertSource(parsed.source, {
      manualInsight: parsed.manualInsight,
    });
    respond(true, { source }, undefined);
  },

  "evolution.insights.list": async ({ params, respond, context }) => {
    if (!validateEvolutionInsightsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid evolution.insights.list params: ${formatValidationErrors(validateEvolutionInsightsListParams.errors)}`,
        ),
      );
      return;
    }
    if (!context.evolution) {
      respond(false, undefined, evolutionUnavailableError());
      return;
    }
    const parsed = params as { limit?: number };
    const insights = await context.evolution.listInsights({ limit: parsed.limit });
    respond(true, { insights }, undefined);
  },

  "evolution.proposals.list": async ({ params, respond, context }) => {
    if (!validateEvolutionProposalsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid evolution.proposals.list params: ${formatValidationErrors(validateEvolutionProposalsListParams.errors)}`,
        ),
      );
      return;
    }
    if (!context.evolution) {
      respond(false, undefined, evolutionUnavailableError());
      return;
    }
    const parsed = params as { limit?: number };
    const proposals = await context.evolution.listProposals({ limit: parsed.limit });
    respond(true, { proposals }, undefined);
  },

  "evolution.proposals.act": async ({ params, respond, context }) => {
    if (!validateEvolutionProposalsActParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid evolution.proposals.act params: ${formatValidationErrors(validateEvolutionProposalsActParams.errors)}`,
        ),
      );
      return;
    }
    if (!context.evolution) {
      respond(false, undefined, evolutionUnavailableError());
      return;
    }
    const parsed = params as {
      proposalId?: string;
      action: "approve" | "reject" | "execute" | "pause";
      paused?: boolean;
      reason?: string;
    };
    const result = await context.evolution.actProposal(parsed);
    respond(true, result, undefined);
  },

  "office.snapshot": async ({ params, respond, context }) => {
    if (!validateOfficeSnapshotParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid office.snapshot params: ${formatValidationErrors(validateOfficeSnapshotParams.errors)}`,
        ),
      );
      return;
    }
    if (!context.evolution) {
      respond(false, undefined, evolutionUnavailableError());
      return;
    }
    const snapshot = await context.evolution.officeSnapshot();
    respond(true, snapshot, undefined);
  },

  "office.layout.get": async ({ params, respond, context }) => {
    if (!validateOfficeLayoutGetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid office.layout.get params: ${formatValidationErrors(validateOfficeLayoutGetParams.errors)}`,
        ),
      );
      return;
    }
    if (!context.evolution) {
      respond(false, undefined, evolutionUnavailableError());
      return;
    }
    const layout = await context.evolution.officeLayoutGet();
    respond(true, { layout }, undefined);
  },

  "office.layout.set": async ({ params, respond, context }) => {
    if (!validateOfficeLayoutSetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid office.layout.set params: ${formatValidationErrors(validateOfficeLayoutSetParams.errors)}`,
        ),
      );
      return;
    }
    if (!context.evolution) {
      respond(false, undefined, evolutionUnavailableError());
      return;
    }
    const parsed = params as { layout: OfficeLayout };
    const layout = await context.evolution.officeLayoutSet(parsed.layout);
    respond(true, { layout }, undefined);
  },
};
