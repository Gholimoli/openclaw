import fs from "node:fs/promises";
import path from "node:path";

const CYCLE_IMPORT_PATTERN =
  /import\s+\{\s*t\s+as\s+__exportAll\s*\}\s+from\s+"\.\/gateway-cli-[^"]+\.js";/g;

async function collectJsFiles(rootDir: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && fullPath.endsWith(".js")) {
        out.push(fullPath);
      }
    }
  }
  return out;
}

async function patchDirectory(rootDir: string): Promise<number> {
  let runtimeFile = "";
  const entries = await fs.readdir(rootDir);
  for (const name of entries) {
    if (/^rolldown-runtime-.*\.js$/.test(name)) {
      runtimeFile = name;
      break;
    }
  }
  if (!runtimeFile) {
    return 0;
  }

  let patched = 0;
  const files = await collectJsFiles(rootDir);
  for (const file of files) {
    const content = await fs.readFile(file, "utf8");
    if (!CYCLE_IMPORT_PATTERN.test(content)) {
      CYCLE_IMPORT_PATTERN.lastIndex = 0;
      continue;
    }
    CYCLE_IMPORT_PATTERN.lastIndex = 0;
    const next = content.replace(
      CYCLE_IMPORT_PATTERN,
      `import { t as __exportAll } from "./${runtimeFile}";`,
    );
    if (next !== content) {
      await fs.writeFile(file, next, "utf8");
      patched += 1;
    }
  }

  return patched;
}

async function main(): Promise<void> {
  const distDir = path.resolve(process.cwd(), "dist");
  const pluginSdkDir = path.resolve(process.cwd(), "dist", "plugin-sdk");

  let totalPatched = 0;
  for (const dir of [distDir, pluginSdkDir]) {
    try {
      totalPatched += await patchDirectory(dir);
    } catch {
      // Directory may not exist in partial builds.
    }
  }

  if (totalPatched > 0) {
    console.log(`[build-fix] patched ${totalPatched} file(s) to avoid __exportAll cycles`);
  }
}

await main();
