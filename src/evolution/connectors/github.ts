import crypto from "node:crypto";
import type { EvolutionInsight, EvolutionSource, EvolutionSourceCursor } from "../types.js";
import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";
import { retryAsync } from "../../infra/retry.js";

type GithubFetchResult = {
  insights: EvolutionInsight[];
  cursor: EvolutionSourceCursor;
};

function parsePublishedAt(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseAuthor(item: Record<string, unknown>): string | undefined {
  const author = item.author;
  if (author && typeof author === "object" && "login" in author) {
    const login = (author as { login?: unknown }).login;
    if (typeof login === "string" && login.trim()) {
      return login;
    }
  }
  const user = item.user;
  if (user && typeof user === "object" && "login" in user) {
    const login = (user as { login?: unknown }).login;
    if (typeof login === "string" && login.trim()) {
      return login;
    }
  }
  return undefined;
}

function normalizeInsight(params: {
  source: EvolutionSource;
  endpointKind: string;
  item: Record<string, unknown>;
}): EvolutionInsight | null {
  const url =
    (typeof params.item.html_url === "string" && params.item.html_url.trim()) ||
    (typeof params.item.url === "string" && params.item.url.trim());
  if (!url) {
    return null;
  }

  const title =
    (typeof params.item.name === "string" && params.item.name) ||
    (typeof params.item.title === "string" && params.item.title) ||
    (typeof params.item.sha === "string" && params.item.sha.slice(0, 12)) ||
    `${params.endpointKind} insight`;
  const body =
    (typeof params.item.body === "string" && params.item.body) ||
    (typeof params.item.message === "string" && params.item.message) ||
    "";
  const evidenceText = `${title}\n\n${body}`.trim();
  const publishedAt =
    parsePublishedAt(params.item.published_at) ||
    parsePublishedAt(params.item.updated_at) ||
    parsePublishedAt(params.item.created_at);
  const fetchedAt = new Date().toISOString();
  const contentHash = crypto
    .createHash("sha256")
    .update(`${url}\n${publishedAt ?? ""}\n${evidenceText}`)
    .digest("hex");

  return {
    id: crypto.randomUUID(),
    sourceId: params.source.id,
    fetchedAt,
    url,
    author: parseAuthor(params.item),
    publishedAt,
    contentHash,
    evidenceText,
    confidence:
      params.source.reliabilityTier === "high"
        ? 0.9
        : params.source.reliabilityTier === "low"
          ? 0.55
          : 0.75,
    tags: Array.from(new Set([...params.source.tags, "github", params.endpointKind])),
  };
}

async function fetchGithubEndpoint(params: {
  url: string;
  etag?: string;
  authToken?: string;
}): Promise<{ status: number; body: unknown; etag?: string }> {
  return await retryAsync(
    async () => {
      const headers: Record<string, string> = {
        "User-Agent": "openclaw-evolution",
        Accept: "application/vnd.github+json",
      };
      if (params.authToken) {
        headers.Authorization = `Bearer ${params.authToken}`;
      }
      if (params.etag) {
        headers["If-None-Match"] = params.etag;
      }

      const { response, release } = await fetchWithSsrFGuard({
        url: params.url,
        init: { headers },
        timeoutMs: 20_000,
        maxRedirects: 2,
      });
      try {
        if (response.status === 304) {
          return { status: 304, body: [], etag: response.headers.get("etag") ?? undefined };
        }
        if (!response.ok) {
          const text = (await response.text()).slice(0, 500);
          throw new Error(`github endpoint failed (${response.status}): ${text}`);
        }
        const body = (await response.json()) as unknown;
        return {
          status: response.status,
          body,
          etag: response.headers.get("etag") ?? undefined,
        };
      } finally {
        await release();
      }
    },
    {
      attempts: 3,
      minDelayMs: 500,
      maxDelayMs: 4000,
      jitter: 0.25,
      label: "evolution-github",
    },
  );
}

function endpointForKind(owner: string, repo: string, kind: string): string {
  switch (kind) {
    case "releases":
      return `https://api.github.com/repos/${owner}/${repo}/releases?per_page=20`;
    case "commits":
      return `https://api.github.com/repos/${owner}/${repo}/commits?per_page=20`;
    case "issues":
      return `https://api.github.com/repos/${owner}/${repo}/issues?state=open&per_page=20`;
    case "prs":
      return `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=20`;
    default:
      return "";
  }
}

export async function fetchGithubInsights(params: {
  source: EvolutionSource;
  cursor?: EvolutionSourceCursor;
  authToken?: string;
}): Promise<GithubFetchResult> {
  const owner = params.source.githubOwner?.trim();
  const repo = params.source.githubRepo?.trim();
  if (!owner || !repo) {
    return {
      insights: [],
      cursor: {
        ...params.cursor,
        fetchedAtMs: Date.now(),
      },
    };
  }

  const cursor = { ...params.cursor };
  const insights: EvolutionInsight[] = [];
  const include =
    params.source.include.length > 0 ? params.source.include : ["releases", "commits"];

  for (const kind of include) {
    const endpoint = endpointForKind(owner, repo, kind);
    if (!endpoint) {
      continue;
    }
    const result = await fetchGithubEndpoint({
      url: endpoint,
      etag: cursor.etag,
      authToken: params.authToken,
    });

    if (result.etag) {
      cursor.etag = result.etag;
    }

    if (result.status === 304) {
      continue;
    }

    const rows = Array.isArray(result.body) ? result.body : [];
    for (const row of rows) {
      if (!row || typeof row !== "object") {
        continue;
      }
      const insight = normalizeInsight({
        source: params.source,
        endpointKind: kind,
        item: row as Record<string, unknown>,
      });
      if (insight) {
        insights.push(insight);
      }
    }
  }

  cursor.fetchedAtMs = Date.now();
  return { insights, cursor };
}
