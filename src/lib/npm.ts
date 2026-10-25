/**
 * Analyze *published* packages without downloading or installing them.
 *
 * Instead of `yarn install`-ing every package into a tmp folder (slow: it
 * downloads and extracts every tarball), we run
 *
 *     npm install <pkg> --package-lock-only --ignore-scripts
 *
 * in an empty tmp directory. npm resolves the complete dependency tree and
 * writes a package-lock.json, but downloads no tarballs and creates no
 * node_modules. The resulting lockfile is then fed through the same
 * analyzer used for local lockfiles.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { analyzeLockfile, type PackageStats } from "./analyze.ts";

const execFileAsync = promisify(execFile);

export interface PackageAnalysis extends PackageStats {
  /** The spec that was requested, e.g. `express` or `@backstage/core-app-api@1.2.3`. */
  spec: string;
  error?: string;
}

/** Split `@scope/name@1.2.3` / `name@^1` / `name` into name and version part. */
export function splitSpec(spec: string): { name: string; version?: string } {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return { name: spec };
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

/**
 * Resolve the full dependency tree of a published package (via a
 * lockfile-only npm install in a tmp dir) and return its stats.
 */
export async function analyzePublishedPackage(spec: string): Promise<PackageAnalysis> {
  const { name } = splitSpec(spec);
  const dir = await mkdtemp(join(tmpdir(), "dep-black-hole-"));
  try {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "dependency-black-hole-probe", version: "0.0.0", private: true })
    );
    await execFileAsync(
      "npm",
      [
        "install",
        spec,
        "--package-lock-only",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
      ],
      { cwd: dir, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 }
    );
    const analysis = analyzeLockfile(join(dir, "package-lock.json"));
    // The requested package is the root's single direct dependency; find its
    // top-level node (there is exactly one top-level instance of a name).
    const target = analysis.packages.find((p) => !p.isRoot && p.name === name);
    if (!target) throw new Error(`package ${name} not found in generated lockfile`);
    return { spec, ...target };
  } catch (error) {
    return {
      spec,
      name,
      version: "?",
      isRoot: false,
      dev: false,
      direct: 0,
      transitive: 0,
      error: error instanceof Error ? (error.message.split("\n")[0] || "failed") : String(error),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Run an async mapper over items with a concurrency limit, preserving order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number, total: number, item: T) => void
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
      done++;
      onProgress?.(done, items.length, items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, limit) }, worker));
  return results;
}

/** Fetch weekly download counts for a list of packages from api.npmjs.org. */
export async function fetchWeeklyDownloads(names: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const scoped = names.filter((n) => n.startsWith("@"));
  const unscoped = names.filter((n) => !n.startsWith("@"));

  // The bulk endpoint accepts up to 128 comma-separated unscoped packages.
  for (let i = 0; i < unscoped.length; i += 100) {
    const batch = unscoped.slice(i, i + 100);
    try {
      const res = await fetch(`https://api.npmjs.org/downloads/point/last-week/${batch.join(",")}`);
      if (!res.ok) continue;
      const data: any = await res.json();
      const entries = batch.length === 1 ? { [batch[0]]: data } : data;
      for (const [name, info] of Object.entries<any>(entries)) {
        if (info && typeof info.downloads === "number") result.set(name, info.downloads);
      }
    } catch {
      // Download counts are informational only; ignore network failures.
    }
  }
  // Scoped packages are not supported by the bulk endpoint.
  await mapLimit(scoped, 8, async (name) => {
    try {
      const res = await fetch(`https://api.npmjs.org/downloads/point/last-week/${name}`);
      if (!res.ok) return;
      const data: any = await res.json();
      if (typeof data.downloads === "number") result.set(name, data.downloads);
    } catch {
      /* ignore */
    }
  });
  return result;
}
