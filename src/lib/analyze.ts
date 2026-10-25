/**
 * Shared analysis helpers: turn a lockfile into per-package dependency
 * counts, sort/filter them, and render the result as a terminal table.
 */

import { statSync } from "node:fs";
import { computeCounts } from "./graph.ts";
import { findLockfile, parseLockfile, type ParseOptions } from "./lockfile.ts";
import { formatCount, renderTable } from "./table.ts";

export interface PackageStats {
  name: string;
  version: string;
  isRoot: boolean;
  dev: boolean;
  direct: number;
  /** Direct + indirect: number of distinct packages this package pulls in. */
  transitive: number;
}

export interface LockfileAnalysis {
  lockfilePath: string;
  kind: string;
  packages: PackageStats[];
  warnings: string[];
}

export function analyzeLockfile(pathOrDir: string, options: ParseOptions = {}): LockfileAnalysis {
  let lockfilePath = pathOrDir;
  if (statSync(pathOrDir).isDirectory()) {
    const found = findLockfile(pathOrDir);
    if (!found) {
      throw new Error(`No package-lock.json, npm-shrinkwrap.json or yarn.lock found in ${pathOrDir}`);
    }
    lockfilePath = found;
  }
  const graph = parseLockfile(lockfilePath, options);
  const counts = computeCounts(graph.nodes);
  const packages = graph.nodes.map((node, i) => ({
    name: node.name,
    version: node.version,
    isRoot: node.isRoot ?? false,
    dev: node.dev ?? false,
    direct: counts[i].direct,
    transitive: counts[i].transitive,
  }));
  return { lockfilePath, kind: graph.kind, packages, warnings: graph.warnings };
}

export type SortKey = "name" | "direct" | "transitive";

export interface SortOptions {
  sort: SortKey;
  ascending: boolean;
  limit?: number;
  filter?: string;
}

export function sortPackages(packages: PackageStats[], options: SortOptions): PackageStats[] {
  let result = [...packages];
  if (options.filter) {
    const needle = options.filter.toLowerCase();
    result = result.filter((p) => p.name.toLowerCase().includes(needle));
  }
  result.sort((a, b) => {
    let cmp: number;
    if (options.sort === "name") {
      cmp = a.name.localeCompare(b.name) || a.version.localeCompare(b.version);
    } else {
      cmp = a[options.sort] - b[options.sort] || a.name.localeCompare(b.name);
    }
    return options.ascending ? cmp : -cmp;
  });
  if (options.limit !== undefined && options.limit >= 0) result = result.slice(0, options.limit);
  return result;
}

export function renderPackagesTable(packages: PackageStats[]): string {
  return renderTable(
    [
      { header: "package" },
      { header: "version" },
      { header: "direct", align: "right" },
      { header: "direct + indirect", align: "right" },
    ],
    packages.map((p) => [
      p.isRoot ? `${p.name} (root)` : p.name,
      p.version,
      formatCount(p.direct),
      formatCount(p.transitive),
    ])
  );
}

/** Parse the shared sorting/filtering CLI flags out of an argv array. */
export function parseSortFlags(args: string[]): { sortOptions: SortOptions; rest: string[] } {
  const sortOptions: SortOptions = { sort: "transitive", ascending: false };
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = (flag: string): string => {
      if (arg.includes("=")) return arg.split("=").slice(1).join("=");
      const next = args[++i];
      if (next === undefined) throw new Error(`Missing value for ${flag}`);
      return next;
    };
    if (arg === "--sort" || arg.startsWith("--sort=")) {
      const key = value("--sort");
      if (key !== "name" && key !== "direct" && key !== "transitive") {
        throw new Error(`Invalid --sort value "${key}" (expected name, direct or transitive)`);
      }
      sortOptions.sort = key;
      // Sorting by name defaults to ascending unless overridden later.
      if (key === "name") sortOptions.ascending = true;
    } else if (arg === "--asc") {
      sortOptions.ascending = true;
    } else if (arg === "--desc") {
      sortOptions.ascending = false;
    } else if (arg === "--limit" || arg.startsWith("--limit=")) {
      sortOptions.limit = Number(value("--limit"));
    } else if (arg === "--filter" || arg.startsWith("--filter=")) {
      sortOptions.filter = value("--filter");
    } else {
      rest.push(arg);
    }
  }
  return { sortOptions, rest };
}
