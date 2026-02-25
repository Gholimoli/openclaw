import crypto from "node:crypto";
import type { EvolutionInsight, EvolutionSource } from "../types.js";
import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";

function extractTextFromHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchManualInsight(params: {
  source: EvolutionSource;
  injectedEvidenceText?: string;
}): Promise<EvolutionInsight | null> {
  const url = params.source.url?.trim();
  if (!url) {
    return null;
  }

  let evidenceText = params.injectedEvidenceText?.trim() || "";
  let author: string | undefined;
  let publishedAt: string | undefined;

  if (!evidenceText) {
    const { response, release } = await fetchWithSsrFGuard({
      url,
      timeoutMs: 20_000,
      maxRedirects: 3,
      init: {
        headers: {
          "User-Agent": "openclaw-evolution",
          Accept: "text/html, text/plain;q=0.9, application/json;q=0.8",
        },
      },
    });
    try {
      if (!response.ok) {
        return null;
      }
      const contentType = response.headers.get("content-type") ?? "";
      const raw = await response.text();
      evidenceText = contentType.includes("html")
        ? extractTextFromHtml(raw).slice(0, 6000)
        : raw.slice(0, 6000);
      const lastModified = response.headers.get("last-modified");
      publishedAt = lastModified ? new Date(lastModified).toISOString() : undefined;
      const serverHeader = response.headers.get("server");
      author = serverHeader?.trim() || undefined;
    } finally {
      await release();
    }
  }

  if (!evidenceText.trim()) {
    return null;
  }

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
    author,
    publishedAt,
    contentHash,
    evidenceText,
    confidence:
      params.source.reliabilityTier === "high"
        ? 0.8
        : params.source.reliabilityTier === "low"
          ? 0.45
          : 0.6,
    tags: Array.from(new Set(["manual", ...params.source.tags])),
  };
}
