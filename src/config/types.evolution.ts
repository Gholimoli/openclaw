export type EvolutionSourceKind = "github_repo" | "manual_url";

export type EvolutionSourceInclude = "releases" | "commits" | "issues" | "prs";

export type EvolutionSourceReliabilityTier = "high" | "medium" | "low";

export type EvolutionSourceSpec = {
  id: string;
  kind: EvolutionSourceKind;
  enabled?: boolean;
  url?: string;
  githubOwner?: string;
  githubRepo?: string;
  include?: EvolutionSourceInclude[];
  tags?: string[];
  reliabilityTier?: EvolutionSourceReliabilityTier;
};

export type EvolutionConfig = {
  enabled?: boolean;
  objective?: "reliability_quality" | "speed" | "cost";
  cadence?: {
    scout?: "hourly";
    synth?: "daily";
  };
  autonomy?: {
    mode?: "merge-low-risk" | "review-only";
    mergeScope?: Array<"docs" | "prompts" | "dashboard">;
  };
  discovery?: {
    mode?: "curated" | "open" | "fixed";
    nominations?: boolean;
  };
  sources?: {
    allowlist?: EvolutionSourceSpec[];
  };
  x?: {
    mode?: "api-first-hybrid";
    browserFallback?: boolean;
  };
  execution?: {
    workTarget?: "state-mirror-repo";
    mergePath?: "local-squash";
    maxConsecutiveFailures?: number;
    maxFailuresPer24h?: number;
  };
};
