import crypto from "node:crypto";
import type {
  EvolutionInsight,
  EvolutionPatchOperation,
  EvolutionProposal,
  EvolutionProposalClass,
  EvolutionProposalScore,
} from "./types.js";
import { evaluateCandidatePaths } from "./policy.js";
import { classifyProposalFromScore, scoreInsight } from "./score.js";

type EmbeddedProposalPayload = {
  title?: string;
  summary?: string;
  candidatePaths?: string[];
  patchOps?: EvolutionPatchOperation[];
};

function parseEmbeddedProposal(evidenceText: string): EmbeddedProposalPayload | null {
  const fenced = evidenceText.match(/```(?:json)?\s*openclaw-evolution\s*([\s\S]*?)```/i);
  const raw = fenced?.[1]?.trim() ?? "";
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as EmbeddedProposalPayload;
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch {
      return null;
    }
  }

  const marker = "openclaw-evolution:";
  const markerIndex = evidenceText.toLowerCase().indexOf(marker);
  if (markerIndex >= 0) {
    const candidate = evidenceText.slice(markerIndex + marker.length).trim();
    try {
      const parsed = JSON.parse(candidate) as EmbeddedProposalPayload;
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch {
      return null;
    }
  }

  return null;
}

function summarizeInsight(insight: EvolutionInsight): { title: string; summary: string } {
  const lines = insight.evidenceText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const title = (lines[0] ?? "Evolution insight").slice(0, 120);
  const summary = (lines.slice(1).join(" ") || lines[0] || "").slice(0, 400);
  return { title, summary };
}

function classPriority(kind: EvolutionProposalClass): number {
  if (kind === "auto_merge_low_risk") {
    return 0;
  }
  if (kind === "needs_review") {
    return 1;
  }
  return 2;
}

function scoreProposal(params: {
  insight: EvolutionInsight;
  candidatePaths: string[];
  hasPatchOps: boolean;
  mergeScope: Array<"docs" | "prompts" | "dashboard">;
}): { score: EvolutionProposalScore; class: EvolutionProposalClass; deniedPaths: string[] } {
  const pathEvaluation = evaluateCandidatePaths(params.candidatePaths, params.mergeScope);
  const score = scoreInsight({
    insight: params.insight,
    hasPatchOps: params.hasPatchOps,
    pathRisk: pathEvaluation.pathRisk,
  });

  let proposalClass = classifyProposalFromScore(score);
  if (proposalClass === "auto_merge_low_risk" && (!pathEvaluation.ok || !params.hasPatchOps)) {
    proposalClass = "needs_review";
  }
  if (score.total < 40) {
    proposalClass = "reject_archive";
  }

  return {
    score,
    class: proposalClass,
    deniedPaths: pathEvaluation.deniedPaths,
  };
}

export function synthesizeProposals(params: {
  insights: EvolutionInsight[];
  existingProposals: EvolutionProposal[];
  mergeScope: Array<"docs" | "prompts" | "dashboard">;
}): EvolutionProposal[] {
  const seenInsightIds = new Set<string>();
  for (const proposal of params.existingProposals) {
    for (const insightId of proposal.insightIds) {
      seenInsightIds.add(insightId);
    }
  }

  const next: EvolutionProposal[] = [];
  for (const insight of params.insights) {
    if (seenInsightIds.has(insight.id)) {
      continue;
    }

    const embedded = parseEmbeddedProposal(insight.evidenceText);
    const summary = summarizeInsight(insight);
    const patchOps = Array.isArray(embedded?.patchOps) ? embedded?.patchOps : undefined;
    const candidatePaths = Array.from(
      new Set([
        ...(embedded?.candidatePaths ?? []),
        ...(patchOps?.map((entry) => entry.path) ?? []),
      ]),
    ).filter(Boolean);

    const scored = scoreProposal({
      insight,
      candidatePaths,
      hasPatchOps: Boolean(patchOps && patchOps.length > 0),
      mergeScope: params.mergeScope,
    });

    const now = Date.now();
    next.push({
      id: crypto.randomUUID(),
      createdAtMs: now,
      updatedAtMs: now,
      title: embedded?.title?.trim() || summary.title,
      summary: embedded?.summary?.trim() || summary.summary,
      insightIds: [insight.id],
      sourceIds: [insight.sourceId],
      candidatePaths,
      score: scored.score,
      class: scored.class,
      status: scored.class === "reject_archive" ? "archived" : "pending",
      reason:
        scored.deniedPaths.length > 0
          ? `Denied paths: ${scored.deniedPaths.join(", ")}`
          : undefined,
      patchOps,
    });
  }

  next.sort((a, b) => {
    const classCompare = classPriority(a.class) - classPriority(b.class);
    if (classCompare !== 0) {
      return classCompare;
    }
    if (a.score.total !== b.score.total) {
      return b.score.total - a.score.total;
    }
    if (a.createdAtMs !== b.createdAtMs) {
      return a.createdAtMs - b.createdAtMs;
    }
    return a.id.localeCompare(b.id);
  });

  return next;
}
