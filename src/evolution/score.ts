import type { EvolutionInsight, EvolutionProposalScore } from "./types.js";

function clampScore(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function keywordImpact(text: string, positive: string[], negative: string[]) {
  const normalized = text.toLowerCase();
  let score = 50;
  for (const key of positive) {
    if (normalized.includes(key)) {
      score += 8;
    }
  }
  for (const key of negative) {
    if (normalized.includes(key)) {
      score -= 8;
    }
  }
  return clampScore(score);
}

export function scoreInsight(params: {
  insight: EvolutionInsight;
  hasPatchOps: boolean;
  pathRisk: number;
}): EvolutionProposalScore {
  const { insight, hasPatchOps, pathRisk } = params;
  const text = `${insight.evidenceText}\n${insight.tags.join(" ")}`;

  const reliabilityImpact = keywordImpact(
    text,
    ["reliability", "stability", "bug", "incident", "outage", "regression", "error"],
    ["experimental", "prototype", "hack"],
  );

  const qualityImpact = keywordImpact(
    text,
    ["quality", "tests", "docs", "maintain", "coverage", "lint"],
    ["temporary", "quick fix"],
  );

  const sourceConfidence = clampScore(insight.confidence * 100);
  const fitWithOpenClawArchitecture = keywordImpact(
    text,
    ["gateway", "control ui", "agent", "cron", "docs", "prompt", "dashboard"],
    ["rewrite", "breaking", "fork"],
  );

  const implementationRisk = clampScore(pathRisk + (hasPatchOps ? 5 : 25));
  const effort = clampScore(hasPatchOps ? 20 : 45);

  const total = clampScore(
    0.32 * reliabilityImpact +
      0.24 * qualityImpact +
      0.18 * sourceConfidence +
      0.16 * fitWithOpenClawArchitecture -
      0.07 * implementationRisk -
      0.03 * effort,
  );

  return {
    reliabilityImpact,
    qualityImpact,
    implementationRisk,
    effort,
    sourceConfidence,
    fitWithOpenClawArchitecture,
    total,
  };
}

export function classifyProposalFromScore(
  score: EvolutionProposalScore,
): "auto_merge_low_risk" | "needs_review" | "reject_archive" {
  if (score.total >= 70 && score.implementationRisk <= 20 && score.effort <= 30) {
    return "auto_merge_low_risk";
  }
  if (score.total >= 40) {
    return "needs_review";
  }
  return "reject_archive";
}
