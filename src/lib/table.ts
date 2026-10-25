/** Tiny dependency-free terminal table renderer. */

export type Align = "left" | "right";

export interface Column {
  header: string;
  align?: Align;
}

export function renderTable(columns: Column[], rows: string[][]): string {
  const widths = columns.map((column, i) =>
    Math.max(column.header.length, ...rows.map((row) => (row[i] ?? "").length))
  );
  const pad = (value: string, i: number) =>
    columns[i].align === "right" ? value.padStart(widths[i]) : value.padEnd(widths[i]);

  const line = (cells: string[]) => `| ${cells.map(pad).join(" | ")} |`;
  const separator = `|${widths.map((w, i) => (columns[i].align === "right" ? `-${"-".repeat(w)}:` : `-${"-".repeat(w)}-`)).join("|")}|`;

  return [line(columns.map((c) => c.header)), separator, ...rows.map(line)].join("\n");
}

/** Format a number with thousands separators. */
export function formatCount(value: number | undefined): string {
  if (value === undefined) return "-";
  return value.toLocaleString("en-US");
}
