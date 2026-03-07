import type { GatewayRequestHandlers } from "./types.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateAutomationAuditQueryParams,
  validateAutomationRunsCancelParams,
  validateAutomationRunsGetParams,
  validateAutomationRunsListParams,
  validateAutomationRunsResumeParams,
} from "../protocol/index.js";

function automationUnavailableError() {
  return errorShape(ErrorCodes.UNAVAILABLE, "automation service unavailable");
}

export const automationHandlers: GatewayRequestHandlers = {
  "automation.runs.list": async ({ params, respond, context }) => {
    if (!validateAutomationRunsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid automation.runs.list params: ${formatValidationErrors(validateAutomationRunsListParams.errors)}`,
        ),
      );
      return;
    }
    if (!context.automation) {
      respond(false, undefined, automationUnavailableError());
      return;
    }
    const parsed = params as { limit?: number; repo?: string; status?: string };
    const runs = await context.automation.listRuns(parsed);
    respond(true, { runs }, undefined);
  },

  "automation.runs.get": async ({ params, respond, context }) => {
    if (!validateAutomationRunsGetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid automation.runs.get params: ${formatValidationErrors(validateAutomationRunsGetParams.errors)}`,
        ),
      );
      return;
    }
    if (!context.automation) {
      respond(false, undefined, automationUnavailableError());
      return;
    }
    const parsed = params as { runId: string };
    const result = await context.automation.getRun(parsed.runId);
    respond(true, result, undefined);
  },

  "automation.runs.resume": async ({ params, respond, context }) => {
    if (!validateAutomationRunsResumeParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid automation.runs.resume params: ${formatValidationErrors(validateAutomationRunsResumeParams.errors)}`,
        ),
      );
      return;
    }
    if (!context.automation) {
      respond(false, undefined, automationUnavailableError());
      return;
    }
    const parsed = params as { runId: string };
    const result = await context.automation.resumeRun(parsed.runId);
    respond(true, result, undefined);
  },

  "automation.runs.cancel": async ({ params, respond, context }) => {
    if (!validateAutomationRunsCancelParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid automation.runs.cancel params: ${formatValidationErrors(validateAutomationRunsCancelParams.errors)}`,
        ),
      );
      return;
    }
    if (!context.automation) {
      respond(false, undefined, automationUnavailableError());
      return;
    }
    const parsed = params as { runId: string; reason?: string };
    const result = await context.automation.cancelRun(parsed.runId, parsed.reason);
    respond(true, result, undefined);
  },

  "automation.audit.query": async ({ params, respond, context }) => {
    if (!validateAutomationAuditQueryParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid automation.audit.query params: ${formatValidationErrors(validateAutomationAuditQueryParams.errors)}`,
        ),
      );
      return;
    }
    if (!context.automation) {
      respond(false, undefined, automationUnavailableError());
      return;
    }
    const entries = await context.automation.queryAudit(
      params as {
        runId?: string;
        repo?: string;
        branch?: string;
        actorId?: string;
        kind?: string;
        limit?: number;
      },
    );
    respond(true, { entries }, undefined);
  },
};
