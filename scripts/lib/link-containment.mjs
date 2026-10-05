// Finds the links in a lychee report that resolve to a local file outside a root. lychee resolves `../` and checks the target exists,
// but never confines it (--root-dir only resolves absolute links), so a packed document can point at a file the package does not have.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const real = (file) => {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
};

/**
 * report is lychee's `--format json --verbose` output. Without --verbose the successful links are only counted, so a report that counts
 * some but lists none is refused rather than read as "nothing outside".
 */
export function linksOutside(report, root) {
  const map = report.success_map ?? {};
  const listed = Object.values(map).reduce((n, links) => n + links.length, 0);
  if ((report.successful ?? 0) > 0 && listed === 0)
    throw new Error("the lychee report lists no successful links; run lychee with --verbose");
  const base = real(root);
  const outside = [];
  for (const [source, links] of Object.entries(map)) {
    for (const { url } of links) {
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        continue;
      }
      if (parsed.protocol !== "file:") continue;
      parsed.hash = "";
      const relative = path.relative(base, real(fileURLToPath(parsed)));
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        outside.push({ source, url });
    }
  }
  return outside;
}
