import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EvolutionInsight } from "./types.js";
import { createEvolutionStore, resolveEvolutionPaths } from "./store.js";

const tempRoots: string[] = [];

async function createTempStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-evolution-store-"));
  tempRoots.push(root);
  const paths = resolveEvolutionPaths(root);
  return createEvolutionStore(paths);
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (!root) {
      continue;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("evolution store", () => {
  it("appends and reads insights from jsonl files", async () => {
    const store = await createTempStore();
    const insight: EvolutionInsight = {
      id: "i1",
      sourceId: "s1",
      fetchedAt: new Date().toISOString(),
      url: "https://example.com",
      contentHash: "h1",
      evidenceText: "evidence",
      confidence: 0.8,
      tags: ["test"],
    };

    await store.appendInsight(insight);
    await store.appendInsight({ ...insight, id: "i2", contentHash: "h2" });

    const insights = await store.readInsights();
    expect(insights.map((entry) => entry.id)).toEqual(["i1", "i2"]);
  });

  it("serializes lock operations in order", async () => {
    const store = await createTempStore();
    const order: string[] = [];

    const a = store.withLock(async () => {
      order.push("a:start");
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push("a:end");
    });
    const b = store.withLock(async () => {
      order.push("b");
    });

    await Promise.all([a, b]);
    expect(order).toEqual(["a:start", "a:end", "b"]);
  });
});
