import {
  AuthStorage as PiAuthStorage,
  ModelRegistry as PiModelRegistry,
} from "@mariozechner/pi-coding-agent";
import path from "node:path";

export type { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";

// Compatibility helpers for pi-coding-agent 0.50+ (discover* helpers removed).
export function discoverAuthStorage(agentDir: string): PiAuthStorage {
  return new PiAuthStorage(path.join(agentDir, "auth.json"));
}

export function discoverModels(authStorage: PiAuthStorage, agentDir: string): PiModelRegistry {
  return new PiModelRegistry(authStorage, path.join(agentDir, "models.json"));
}
