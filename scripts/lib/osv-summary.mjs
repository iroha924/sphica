// Summarizes osv-scanner's JSON output (`--format=json`) for the release run. A scan that left no readable results is
// `unavailable`, never `none`: only a well-formed result with no vulnerabilities says there are none.

// A code span shows a name from the results file as typed (no links, images, emphasis, or character references). A backtick
// would close the span and a pipe the table cell, so they are replaced and escaped
const cell = (value) => {
  const text = String(value)
    .replace(/[\r\n]+/g, " ")
    .replaceAll("`", "'")
    .replaceAll("|", "\\|");
  return text.trim() ? `\`${text}\`` : "";
};

/** Packages with vulnerabilities, or null when the shape is not osv-scanner's. */
function vulnerable(report) {
  if (!report || typeof report !== "object" || !Array.isArray(report.results)) return null;
  const rows = [];
  for (const result of report.results) {
    if (!result || typeof result !== "object" || !Array.isArray(result.packages)) return null;
    for (const entry of result.packages) {
      const pkg = entry?.package;
      if (!pkg || typeof pkg.name !== "string" || typeof pkg.version !== "string") return null;
      const vulns = entry.vulnerabilities ?? [];
      if (!Array.isArray(vulns) || vulns.some((v) => typeof v?.id !== "string")) return null;
      // Groups hold the IDs of the package's vulnerabilities, so groups without them mean a partial result
      const grouped =
        Array.isArray(entry.groups) && entry.groups.some((g) => Array.isArray(g?.ids) && g.ids.length > 0);
      if (vulns.length === 0 && grouped) return null;
      if (vulns.length === 0) continue;
      rows.push({
        name: pkg.name,
        version: pkg.version,
        ecosystem: String(pkg.ecosystem ?? ""),
        ids: vulns.map((v) => v.id),
      });
    }
  }
  return rows;
}

/**
 * `text` is the results file's contents, null when the file is missing, or `{ code }` when reading it failed. `count` is the
 * number of distinct vulnerability IDs (aliases are not merged); the table has one row per package and version.
 */
export function osvSummary(text, sha) {
  const head = `### OSV scan of \`${sha}\``;
  let report;
  let reason = "";
  if (text === null) reason = "the scan wrote no results file";
  else if (typeof text !== "string")
    reason = `the results file could not be read (${String(text.code ?? "unknown error")})`;
  else if (text.trim() === "") reason = "the results file is empty";
  else {
    try {
      report = JSON.parse(text);
    } catch {
      reason = "the results file is not JSON";
    }
  }
  const rows = reason ? null : vulnerable(report);
  if (!rows) {
    reason ||= "the results file is not osv-scanner's JSON";
    return {
      status: "unavailable",
      count: 0,
      markdown: `${head}\n\nResults unavailable: ${reason}. See the scan step's log.\n`,
    };
  }
  if (rows.length === 0)
    return { status: "none", count: 0, markdown: `${head}\n\nNo known vulnerabilities.\n` };
  const count = new Set(rows.flatMap((r) => r.ids)).size;
  const table = rows.map(
    (r) => `| ${cell(r.name)} | ${cell(r.version)} | ${cell(r.ecosystem)} | ${r.ids.map(cell).join(", ")} |`,
  );
  return {
    status: "found",
    count,
    markdown: [
      head,
      "",
      `${count} known ${count === 1 ? "vulnerability" : "vulnerabilities"} in ${rows.length} ${rows.length === 1 ? "package" : "packages"}. They do not stop the release.`,
      "",
      "| package | version | ecosystem | IDs |",
      "|---|---|---|---|",
      ...table,
      "",
    ].join("\n"),
  };
}

/** The one line the approval comment carries. */
export function osvLine({ status, count }, sha) {
  if (status === "found")
    return `OSV scan of ${sha}: ${count} known ${count === 1 ? "vulnerability" : "vulnerabilities"} (see the run summary)`;
  if (status === "none") return `OSV scan of ${sha}: no known vulnerabilities`;
  return `OSV scan of ${sha}: results unavailable (see the run summary)`;
}
