/** Write analysis results as markdown + JSON into the results/ directory. */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PackageAnalysis } from "./npm.ts";
import { formatCount, renderTable, type Column } from "./table.ts";

export interface ReportOptions {
  title: string;
  intro: string;
  markdownPath: string;
  jsonPath: string;
  results: PackageAnalysis[];
  /** Extra leading columns, e.g. rank or weekly downloads. */
  extraColumns?: { column: Column; value: (r: PackageAnalysis, index: number) => string }[];
  generatedWith: string;
}

export function summarize(results: PackageAnalysis[]): string {
  const ok = results.filter((r) => !r.error);
  if (ok.length === 0) return "No packages could be analyzed.";
  const zeroDeps = ok.filter((r) => r.transitive === 0);
  const sortedByTransitive = [...ok].sort((a, b) => b.transitive - a.transitive);
  const totalTransitive = ok.reduce((sum, r) => sum + r.transitive, 0);
  const median = sortedByTransitive[Math.floor(sortedByTransitive.length / 2)].transitive;
  const worst = sortedByTransitive[0];
  const lines = [
    `- **${ok.length}** packages analyzed`,
    `- **${zeroDeps.length}** (${Math.round((zeroDeps.length / ok.length) * 100)} %) have **zero** dependencies`,
    `- average **${Math.round(totalTransitive / ok.length)}** and median **${median}** total (direct + indirect) dependencies`,
    `- biggest tree: **${worst.name}@${worst.version}** with **${worst.transitive}** total dependencies (${worst.direct} direct)`,
  ];
  const failed = results.filter((r) => r.error);
  if (failed.length > 0) lines.push(`- ${failed.length} package(s) could not be analyzed: ${failed.map((r) => r.spec).join(", ")}`);
  return lines.join("\n");
}

export function writeReport(options: ReportOptions): void {
  const { results } = options;
  const ok = results.filter((r) => !r.error);
  const extra = options.extraColumns ?? [];
  const table = renderTable(
    [
      ...extra.map((e) => e.column),
      { header: "package" },
      { header: "version" },
      { header: "direct", align: "right" },
      { header: "direct + indirect", align: "right" },
    ],
    ok.map((r, i) => [
      ...extra.map((e) => e.value(r, i)),
      r.name,
      r.version,
      formatCount(r.direct),
      formatCount(r.transitive),
    ])
  );

  const markdown = [
    `# ${options.title}`,
    "",
    options.intro,
    "",
    "## Summary",
    "",
    summarize(results),
    "",
    "## Results",
    "",
    table,
    "",
    `_Generated on ${new Date().toISOString().slice(0, 10)} with \`${options.generatedWith}\`. Dependency counts are production dependencies (including optional, excluding dev/peer), resolved via \`npm install --package-lock-only\`._`,
    "",
  ].join("\n");

  mkdirSync(dirname(options.markdownPath), { recursive: true });
  writeFileSync(options.markdownPath, markdown);
  writeFileSync(options.jsonPath, JSON.stringify(results, null, 2) + "\n");
}
