/**
 * Lockfile parsers: turn a package-lock.json (v1/v2/v3) or yarn.lock
 * (classic v1 or Berry/v2+) into a dependency graph of resolved packages.
 */

import { readFileSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { GraphNode } from "./graph.ts";

export interface ParseOptions {
  /** Follow peerDependencies edges when the peer is present in the tree. */
  includePeers?: boolean;
}

export interface LockfileGraph {
  nodes: GraphNode[];
  /** "package-lock" | "yarn-classic" | "yarn-berry" */
  kind: string;
  lockfileVersion?: number;
  warnings: string[];
}

interface NpmLockEntry {
  name?: string;
  version?: string;
  link?: boolean;
  resolved?: string;
  dev?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  requires?: Record<string, string> | boolean;
}

/** Derive the package name from a v2/v3 lockfile path like `node_modules/@scope/name`. */
function nameFromPath(path: string): string {
  const idx = path.lastIndexOf("node_modules/");
  const tail = idx === -1 ? path : path.slice(idx + "node_modules/".length);
  return tail;
}

/**
 * Parse npm package-lock.json v2/v3 (flat `packages` map keyed by install path).
 * Dependency edges are resolved with the same nearest-`node_modules` walk-up
 * rule Node.js itself uses.
 */
function parseNpmLockV2(lock: any, options: ParseOptions): LockfileGraph {
  const warnings: string[] = [];
  const packages: Record<string, NpmLockEntry> = lock.packages ?? {};

  // Resolve `link: true` entries (workspace symlinks) to their target path.
  const resolvePath = (path: string): string => {
    const entry = packages[path];
    if (entry?.link && entry.resolved && packages[entry.resolved]) return entry.resolved;
    return path;
  };

  const nodeIndexByPath = new Map<string, number>();
  const nodes: GraphNode[] = [];
  for (const [path, entry] of Object.entries(packages)) {
    if (entry.link) continue; // alias handled via resolvePath
    const name = path === "" ? (entry.name ?? "(root)") : (entry.name ?? nameFromPath(path));
    const version = entry.version ?? "?";
    nodeIndexByPath.set(path, nodes.length);
    nodes.push({
      id: path === "" ? `${name} (root)` : `${name}@${version}`,
      name,
      version,
      isRoot: path === "" || !path.includes("node_modules"),
      dev: entry.dev,
      deps: [],
    });
  }

  // Nearest-node_modules lookup: try `${base}/node_modules/${dep}`, walking up.
  const lookup = (fromPath: string, dep: string): string | undefined => {
    let base = fromPath;
    for (;;) {
      const candidate = base === "" ? `node_modules/${dep}` : `${base}/node_modules/${dep}`;
      if (packages[candidate]) return resolvePath(candidate);
      if (base === "") return undefined;
      const cut = base.lastIndexOf("/node_modules/");
      base = cut === -1 ? "" : base.slice(0, cut);
    }
  };

  for (const [path, entry] of Object.entries(packages)) {
    if (entry.link) continue;
    const fromIndex = nodeIndexByPath.get(path)!;
    const isRootLike = nodes[fromIndex].isRoot;
    const declared: Record<string, string> = {
      ...entry.dependencies,
      ...entry.optionalDependencies,
      ...(options.includePeers ? entry.peerDependencies : {}),
      // devDependencies are only installed for the root / workspace packages.
      ...(isRootLike ? entry.devDependencies : {}),
    };
    const targets = new Set<number>();
    for (const dep of Object.keys(declared)) {
      const targetPath = lookup(path, dep);
      if (targetPath === undefined) continue; // e.g. skipped optional dependency
      const targetIndex = nodeIndexByPath.get(targetPath);
      if (targetIndex !== undefined && targetIndex !== fromIndex) targets.add(targetIndex);
    }
    nodes[fromIndex].deps = [...targets];
  }

  return { nodes, kind: "package-lock", lockfileVersion: lock.lockfileVersion, warnings };
}

/** Parse npm package-lock.json v1 (nested `dependencies` tree with `requires`). */
function parseNpmLockV1(lock: any, lockfilePath: string, options: ParseOptions): LockfileGraph {
  const warnings: string[] = [];

  // Flatten the nested tree into a v2-style path map, then reuse the same
  // walk-up resolution.
  const packages: Record<string, NpmLockEntry> = {};
  const flatten = (deps: Record<string, any> | undefined, base: string) => {
    if (!deps) return;
    for (const [name, entry] of Object.entries<any>(deps)) {
      const path = base === "" ? `node_modules/${name}` : `${base}/node_modules/${name}`;
      packages[path] = {
        version: entry.version,
        dev: entry.dev,
        dependencies:
          typeof entry.requires === "object" && entry.requires ? entry.requires : undefined,
      };
      flatten(entry.dependencies, path);
    }
  };
  flatten(lock.dependencies, "");

  // v1 lockfiles do not record the root's own dependency list; read the
  // package.json next to the lockfile when available.
  const rootEntry: NpmLockEntry = { name: lock.name ?? "(root)", version: lock.version };
  const pkgJsonPath = join(dirname(lockfilePath), "package.json");
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
      rootEntry.dependencies = { ...pkg.dependencies, ...pkg.optionalDependencies };
      rootEntry.devDependencies = pkg.devDependencies;
    } catch {
      warnings.push(`Could not read ${pkgJsonPath}; root dependencies unknown.`);
    }
  } else {
    warnings.push(
      "package-lock v1 does not list the root's direct dependencies and no package.json was found next to the lockfile; the root row is omitted."
    );
  }
  packages[""] = rootEntry;

  const graph = parseNpmLockV2({ packages, lockfileVersion: 1 }, options);
  graph.warnings.push(...warnings);
  return graph;
}

interface YarnEntry {
  selectors: string[]; // e.g. ["lodash@^4.17.20", "lodash@^4.17.21"]
  version?: string;
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
}

/**
 * Minimal parser for yarn lockfiles. Handles both the classic v1 format
 * (`version "1.2.3"`, deps as `name "range"`) and the Berry YAML format
 * (`version: 1.2.3`, deps as `name: "npm:range"`).
 */
function parseYarnEntries(text: string): { entries: YarnEntry[]; isBerry: boolean } {
  const entries: YarnEntry[] = [];
  const isBerry = /__metadata:/.test(text);
  let current: YarnEntry | undefined;
  let currentBlock: "dependencies" | "optionalDependencies" | "peerDependencies" | undefined;

  const unquote = (s: string): string => {
    s = s.trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      return s.slice(1, -1);
    }
    return s;
  };

  // Split a `key: value` (Berry) or `key "value"` (classic) field line.
  const splitField = (line: string): [string, string] | undefined => {
    const trimmed = line.trim();
    let m = trimmed.match(/^("[^"]+"|[^\s:]+):\s+(.*)$/); // berry: key: value
    if (m) return [unquote(m[1]), unquote(m[2])];
    m = trimmed.match(/^("[^"]+"|\S+)\s+(.*)$/); // classic: key "value"
    if (m) return [unquote(m[1]), unquote(m[2])];
    return undefined;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
    const indent = rawLine.length - rawLine.trimStart().length;

    if (indent === 0) {
      // New entry header: `selector1, selector2:`
      const header = rawLine.trim().replace(/:$/, "");
      if (header === "__metadata") {
        current = undefined;
        continue;
      }
      const selectors = header
        .split(",")
        .map((s) => unquote(s))
        .filter(Boolean);
      current = {
        selectors,
        dependencies: {},
        optionalDependencies: {},
        peerDependencies: {},
      };
      currentBlock = undefined;
      entries.push(current);
    } else if (current) {
      const trimmed = rawLine.trim();
      if (indent === 2) {
        currentBlock = undefined;
        if (/^dependencies:?$/.test(trimmed)) currentBlock = "dependencies";
        else if (/^optionalDependencies:?$/.test(trimmed)) currentBlock = "optionalDependencies";
        else if (/^peerDependencies:?$/.test(trimmed)) currentBlock = "peerDependencies";
        else {
          const field = splitField(rawLine);
          if (field && field[0] === "version") current.version = field[1];
        }
      } else if (indent >= 4 && currentBlock) {
        const field = splitField(rawLine);
        if (field) current[currentBlock][field[0]] = field[1];
      }
    }
  }
  return { entries, isBerry };
}

/** Split `@scope/name@range` / `name@npm:range` into name and range. */
function splitSelector(selector: string): { name: string; range: string } {
  const at = selector.lastIndexOf("@");
  if (at <= 0) return { name: selector, range: "*" };
  const name = selector.slice(0, at);
  let range = selector.slice(at + 1);
  if (range.startsWith("npm:")) range = range.slice(4);
  return { name, range };
}

function parseYarnLock(text: string, lockfilePath: string, options: ParseOptions): LockfileGraph {
  const warnings: string[] = [];
  const { entries, isBerry } = parseYarnEntries(text);

  // Dedupe entries into name@version nodes; index every selector for edge resolution.
  const nodes: GraphNode[] = [];
  const nodeIndexById = new Map<string, number>();
  const selectorIndex = new Map<string, number>();
  const entryNode = new Map<YarnEntry, number>();

  for (const entry of entries) {
    if (entry.selectors.length === 0) continue;
    const { name } = splitSelector(entry.selectors[0]);
    const version = entry.version ?? "?";
    const id = `${name}@${version}`;
    let index = nodeIndexById.get(id);
    if (index === undefined) {
      index = nodes.length;
      nodeIndexById.set(id, index);
      nodes.push({
        id,
        name,
        version,
        isRoot: isBerry && entry.selectors.some((s) => s.includes("@workspace:")),
        deps: [],
      });
    }
    entryNode.set(entry, index);
    for (const selector of entry.selectors) {
      const { name: selName, range } = splitSelector(selector);
      selectorIndex.set(`${selName}@${range}`, index);
      selectorIndex.set(selector, index);
    }
  }

  const resolveDep = (name: string, range: string): number | undefined => {
    let r = range;
    if (r.startsWith("npm:")) r = r.slice(4);
    return (
      selectorIndex.get(`${name}@${r}`) ??
      selectorIndex.get(`${name}@npm:${r}`) ??
      selectorIndex.get(`${name}@${range}`)
    );
  };

  const unresolved = new Set<string>();
  for (const entry of entries) {
    const fromIndex = entryNode.get(entry);
    if (fromIndex === undefined) continue;
    const declared = {
      ...entry.dependencies,
      ...entry.optionalDependencies,
      ...(options.includePeers ? entry.peerDependencies : {}),
    };
    const targets = new Set<number>(nodes[fromIndex].deps);
    for (const [dep, range] of Object.entries(declared)) {
      const target = resolveDep(dep, range);
      if (target === undefined) {
        // Peers and skipped optionals may legitimately be absent.
        if (!options.includePeers) unresolved.add(`${dep}@${range}`);
        continue;
      }
      if (target !== fromIndex) targets.add(target);
    }
    nodes[fromIndex].deps = [...targets];
  }

  // Classic yarn.lock has no root entry; synthesize one from package.json.
  if (!isBerry) {
    const pkgJsonPath = join(dirname(lockfilePath), "package.json");
    if (existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
        const declared: Record<string, string> = {
          ...pkg.dependencies,
          ...pkg.optionalDependencies,
          ...pkg.devDependencies,
        };
        const targets = new Set<number>();
        for (const [dep, range] of Object.entries(declared)) {
          const target = resolveDep(dep, String(range));
          if (target !== undefined) targets.add(target);
        }
        nodes.push({
          id: `${pkg.name ?? "(root)"} (root)`,
          name: pkg.name ?? "(root)",
          version: pkg.version ?? "?",
          isRoot: true,
          deps: [...targets],
        });
      } catch {
        warnings.push(`Could not read ${pkgJsonPath}; no root row shown.`);
      }
    } else {
      warnings.push(
        "yarn.lock does not contain the project's own dependency list and no package.json was found next to it; no root row is shown."
      );
    }
  }

  if (unresolved.size > 0) {
    warnings.push(`${unresolved.size} dependency range(s) could not be resolved in the lockfile (often fine: skipped optional/platform-specific packages).`);
  }

  return { nodes, kind: isBerry ? "yarn-berry" : "yarn-classic", warnings };
}

/** Parse a lockfile by path. Accepts package-lock.json, npm-shrinkwrap.json or yarn.lock. */
export function parseLockfile(path: string, options: ParseOptions = {}): LockfileGraph {
  const file = basename(path);
  const text = readFileSync(path, "utf8");
  if (file === "yarn.lock") return parseYarnLock(text, path, options);
  const lock = JSON.parse(text);
  if (lock.lockfileVersion >= 2) return parseNpmLockV2(lock, options);
  return parseNpmLockV1(lock, path, options);
}

/** Find a lockfile in a directory: package-lock.json > npm-shrinkwrap.json > yarn.lock. */
export function findLockfile(dir: string): string | undefined {
  for (const candidate of ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock"]) {
    const path = join(dir, candidate);
    if (existsSync(path)) return path;
  }
  return undefined;
}
