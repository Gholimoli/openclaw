import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { ensureAuthProfileStore, listProfilesForProvider } from "./auth-profiles.js";

type AuthJsonCredential =
  | {
      type: "api_key";
      key: string;
    }
  | {
      type: "oauth";
      access: string;
      refresh: string;
      expires: number;
      [key: string]: unknown;
    };

type AuthJsonShape = Record<string, AuthJsonCredential>;

function readAuthJsonSync(filePath: string): AuthJsonShape {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return parsed as AuthJsonShape;
  } catch {
    return {};
  }
}

function selectManagedAuthEntries(agentDir: string): AuthJsonShape {
  const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
  const providers = new Set(
    Object.values(store.profiles)
      .map((profile) => profile.provider)
      .filter(
        (provider): provider is string => typeof provider === "string" && provider.length > 0,
      ),
  );
  const next: AuthJsonShape = {};

  for (const provider of providers) {
    const profileId = listProfilesForProvider(store, provider)[0];
    const cred = profileId ? store.profiles[profileId] : undefined;
    if (!cred) {
      continue;
    }

    if (cred.type === "api_key") {
      const key = typeof cred.key === "string" ? cred.key.trim() : "";
      if (key) {
        next[provider] = { type: "api_key", key };
      }
      continue;
    }

    if (cred.type !== "oauth") {
      continue;
    }

    const access = typeof cred.access === "string" ? cred.access.trim() : "";
    const refresh = typeof cred.refresh === "string" ? cred.refresh.trim() : "";
    const expires = typeof cred.expires === "number" ? cred.expires : Number.NaN;
    if (!access || !refresh || !Number.isFinite(expires) || expires <= 0) {
      continue;
    }

    const oauthEntry: AuthJsonCredential = {
      type: "oauth",
      access,
      refresh,
      expires,
    };

    for (const [key, value] of Object.entries(cred)) {
      if (
        key === "type" ||
        key === "provider" ||
        key === "access" ||
        key === "refresh" ||
        key === "expires"
      ) {
        continue;
      }
      oauthEntry[key] = value;
    }

    next[provider] = oauthEntry;
  }

  return next;
}

function mergeManagedAuthEntries(params: {
  existing: AuthJsonShape;
  managed: AuthJsonShape;
}): AuthJsonShape {
  const next = { ...params.existing };
  for (const [provider, credential] of Object.entries(params.managed)) {
    next[provider] = credential;
  }
  return next;
}

function authJsonEntriesEqual(a: AuthJsonShape, b: AuthJsonShape): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * pi-coding-agent's ModelRegistry/AuthStorage expects OAuth credentials in auth.json.
 *
 * OpenClaw stores OAuth credentials in auth-profiles.json instead. This helper
 * bridges a subset of credentials into agentDir/auth.json so pi-coding-agent can
 * (a) consider the provider authenticated and (b) include built-in models in its
 * registry/catalog output.
 *
 * Currently used for OAuth/API-key providers that pi-coding-agent discovers via auth.json.
 */
export function ensurePiAuthJsonFromAuthProfilesSync(agentDir: string): {
  wrote: boolean;
  authPath: string;
} {
  const authPath = path.join(agentDir, "auth.json");
  const managed = selectManagedAuthEntries(agentDir);
  if (Object.keys(managed).length === 0) {
    return { wrote: false, authPath };
  }
  const existing = readAuthJsonSync(authPath);
  const next = mergeManagedAuthEntries({ existing, managed });
  if (authJsonEntriesEqual(existing, next)) {
    return { wrote: false, authPath };
  }

  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(authPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });

  return { wrote: true, authPath };
}

export async function ensurePiAuthJsonFromAuthProfiles(agentDir: string): Promise<{
  wrote: boolean;
  authPath: string;
}> {
  const result = ensurePiAuthJsonFromAuthProfilesSync(agentDir);
  if (!result.wrote) {
    return result;
  }
  await fsp.chmod(result.authPath, 0o600);
  return result;
}
