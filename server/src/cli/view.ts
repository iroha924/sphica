// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// CLI output: Clack in a terminal, plain indented text in pipes (an AI reading through Bash, the harvest log). Parts return strings for console.log.
// **Only the heading and the closing line start a line**, so outside text cannot forge a status line (test/view.test.ts, test/cli.test.ts check).
// The recording hooks do not load Clack and keep the server/src/panel.ts format.

import { Writable } from "node:stream";
import { styleText } from "node:util";
import { box, cancel, intro, log, outro, spinner } from "@clack/prompts";
import stringWidth from "fast-string-width";
import { wrapAnsi } from "fast-wrap-ansi";
import { mark, plain } from "../panel.ts";

/** Drawn with Clack only when both stdout and stderr are terminals (the same condition as panel.ts mark). In pipes an AI reads it, so no decoration */
const colored = () => Boolean(process.stdout.isTTY && process.stderr.isTTY) && !process.env.NO_COLOR;

/** Wrap at the terminal width in a terminal. Never wrap in pipes (a path or URL cut midway cannot be rejoined by the reader) */
const columns = () => (process.stdout.isTTY ? Math.max(10, process.stdout.columns || 100) : 10_000);

/** What Clack writes, as one string. The trailing newline is dropped because console.log adds it back */
function capture(draw: (output: Writable) => void): string {
  let text = "";
  const output = new Writable({
    write(chunk, _encoding, done) {
      text += String(chunk);
      done();
    },
  });
  Object.assign(output, { columns: columns(), isTTY: true });
  draw(output);
  return text.replace(/\n$/, "");
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: splits out color sequences (SGR) so they survive cleaning
const SGR = /(\u001b\[[0-9;]*m)/;

/**
 * Keeps colors (such as the mark from panel.ts) and cleans everything else with plain: CR and other line breaks become LF, and cursor
 * and other control sequences are dropped, so outside text cannot move to the line start or erase the guide.
 */
const clean = (text: string): string =>
  text
    .split(SGR)
    .map((piece, i) => (i % 2 ? piece : plain(piece)))
    .join("");

/** Joins into one line (headings, closing lines, cells). Callers pass outside text through plain / inline first */
const oneLine = (text: string) => clean(text).replace(/[\n\t]+/g, " ");

const bold = (text: string) => styleText("bold", text);
const dim = (text: string) => styleText("dim", text);

/** A heading or closing line without Clack. Where stdout is a terminal it wraps, continuing indented, so no continuation starts a line */
const plainLine = (text: string): string =>
  wrapAnsi(oneLine(text), columns() - 2, { hard: true, trim: true })
    .split("\n")
    .join("\n  ");

/** Clack's guide adds 3 columns (│ and 2 spaces) before each content line */
const GUIDE = 3;

/** A line starting with a mark (panel.ts mark; a color sequence may precede it). Has columns such as label, version, value */
// biome-ignore lint/suspicious/noControlCharactersInRegex: skips the color sequence before the mark
const MARKED = /^(?:\u001b\[[0-9;]*m)*[✓△✗○](?:\u001b\[[0-9;]*m)* /;

/**
 * Wraps one line at room columns. Continuations align with the start of that line's text; in lines starting with a mark, two or more
 * spaces separate columns and continuations align with the last column (the value). Blank lines stay blank
 */
function wrapLine(line: string, room: number): string[] {
  const body = line.trimStart();
  if (body === "") return [""];
  const lead = line.length - body.length;
  const cells = MARKED.test(body) ? /^(.*\S\s{2,})(\S.*)$/.exec(body) : null;
  const label = cells?.[1] ?? "";
  const hang = lead + stringWidth(label);
  // A label too wide to leave room for its value wraps as ordinary text
  const [head, text, at] = cells?.[2] && room - hang >= 10 ? [label, cells[2], hang] : ["", body, lead];
  return wrapAnsi(text, Math.max(1, room - at), { hard: true, trim: true })
    .split("\n")
    .map((part, i) => (i === 0 ? `${" ".repeat(lead)}${head}${part}` : `${" ".repeat(at)}${part}`));
}

/** Content lines behind the guide (terminal) or indented by 2 (pipes). spacing is the number of bare │ lines before them */
function content(lines: string[], spacing = 0): string {
  const cleaned = lines.flatMap((l) => clean(l).split("\n"));
  if (!colored()) {
    const wrapped = cleaned.flatMap((l) => wrapLine(l, columns() - 2));
    return wrapped.map((l) => (l ? `  ${l}` : "")).join("\n");
  }
  const wrapped = cleaned.flatMap((l) => wrapLine(l, columns() - GUIDE));
  return capture((output) => log.message(wrapped, { output, spacing }));
}

/**
 * A heading. In a terminal it opens Clack's frame, with the summary (meta) dimmed beside it and cut at the terminal width.
 * In pipes it is the text alone on one line (the summary goes to the closing line; an AI reads it).
 */
export function title(text: string, meta?: string): string {
  if (!colored()) return plainLine(text);
  // The inverted heading adds a space on each side; a heading wider than the terminal is cut
  const t = cut(oneLine(text), columns() - GUIDE - 2);
  const room = columns() - GUIDE - stringWidth(t) - 2;
  const extra = meta && room > 8 ? `  ${cut(oneLine(meta), room - 2)}` : "";
  return capture((output) =>
    intro(`${styleText(["inverse", "bold"], ` ${t} `)}${extra ? dim(extra) : ""}`, { output }),
  );
}

/**
 * A spinner for one slow step in a terminal; message updates the text while it runs. In pipes (the harvest log) nothing is drawn,
 * and callers print their result lines as before. It only moves while the step awaits (gh runs asynchronously; git and SQLite block)
 */
export function progress(
  label: string,
  output: Writable = process.stdout,
): {
  message(text: string): void;
  done(text: string): void;
  fail(text: string): void;
} {
  if (!colored()) return { message() {}, done() {}, fail() {} };
  const s = spinner({ output });
  // Clack writes these as they are, so they are cut to fit behind the frame symbol (3 columns)
  const fit = (t: string) => cut(oneLine(t), columns() - GUIDE);
  s.start(fit(label));
  return {
    message: (t) => s.message(fit(t)),
    done: (t) => s.stop(fit(t)),
    fail: (t) => s.error(fit(t)),
  };
}

/** A section heading. A Clack step in a terminal, an indented line in pipes (after a blank line with gap) */
export function section(text: string, gap = false): string {
  const t = oneLine(text);
  if (!colored()) return `${gap ? "\n" : ""}  ${t}`;
  return capture((output) => log.step(bold(t), { output }));
}

/** Content lines. Every line sits behind the guide or is indented by 2 or more (see wrapLine for how long lines wrap) */
export function indent(text: string): string {
  return content(text.split("\n"));
}

/** The closing line. It is the only line besides the heading at the line start, so newlines collapse into one line (no forged lines) */
export function closing(text: string): string {
  if (!colored()) return plainLine(text);
  const t = oneLine(text);
  // Wrapped here, not by the terminal, so a continuation starts indented rather than at column 0
  const lines = wrapAnsi(t, columns() - GUIDE, { hard: true, trim: true }).split("\n");
  return capture((output) => outro(bold(lines.join(`\n${" ".repeat(GUIDE)}`)), { output }));
}

/** One block of heading, content, and closing */
export function panel(head: string, lines: string[], end: string): string {
  return document(head, undefined, lines.length ? [{ kind: "lines", lines }] : [], end);
}

/** One item in a document: a badge (its kind), title, body, and sources (each dimmed on its own line, never cut) */
type Card = { badge?: string; title: string; body?: string; meta?: string[] };

/**
 * Document sections. Outside text only goes behind the guide or inside indentation.
 *   lines indented lines / table a table / cards items with a badge / fields labels and values / meter a ratio bar / note one line with a mark
 */
export type Block =
  | { kind: "lines"; lines: string[] }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "cards"; items: Card[] }
  | { kind: "fields"; rows: [string, string][] }
  | { kind: "meter"; label: string; ratio: number; text: string }
  | { kind: "note"; tone: "info" | "warning" | "error" | "success"; text: string };

/** A document of heading, sections, and closing. Terminals put a bare guide line between sections */
export function document(head: string, meta: string | undefined, blocks: Block[], end: string): string {
  return [title(head, meta), ...blocks.map(drawBlock), closing(end)].filter((x) => x !== "").join("\n");
}

/** A failure document. Terminals show the reason as a Clack error and close with Stopped; pipes print the indented reason and `✗ Stopped` */
export function failure(head: string, reason: string): string {
  return [title(head), stopped(reason)].join("\n");
}

/** The reason and the Stopped line that close a frame already opened with title (a failure after output has started) */
export function stopped(reason: string): string {
  if (!colored()) return [indent(reason), closing(`${mark("fail")} Stopped`)].join("\n");
  const lines = clean(reason).split("\n");
  const [first = "", ...rest] = lines.flatMap((l) => wrapLine(l, columns() - GUIDE));
  return capture((output) => {
    log.error(first, { output });
    if (rest.length) log.message(rest, { output, spacing: 0 });
    cancel("Stopped", { output });
  }).replace(/\n+$/, "");
}

const cell = (text: string) => oneLine(text).trim();

/** Cuts text to at most room columns (tables keep one row per line) */
const cut = (text: string, room: number) =>
  stringWidth(text) <= room
    ? text
    : `${wrapAnsi(text, Math.max(1, room - 1), { hard: true }).split("\n")[0]}…`;

const padTo = (text: string, to: number) => text + " ".repeat(Math.max(0, to - stringWidth(text)));

function drawBlock(b: Block): string {
  const fancy = colored();
  const space = fancy ? 1 : 0;
  switch (b.kind) {
    case "lines":
      return content(b.lines, space);
    case "table": {
      // Every column but the last is as wide as its longest cell (up to 40). The last column is cut to the remaining width
      const rows = [b.head, ...b.rows].map((r) => r.map(cell));
      if (!fancy) return content(rows.map((r) => r.join("  ")));
      const widths = b.head.map((_, i) =>
        Math.min(40, Math.max(...rows.map((r) => stringWidth(r[i] ?? "")))),
      );
      const room = columns() - GUIDE;
      const line = (r: string[], head: boolean) => {
        const before = r.slice(0, -1).map((c, i) => padTo(cut(c, widths[i] ?? 0), (widths[i] ?? 0) + 3));
        const used = before.reduce((w, c) => w + stringWidth(c), 0);
        const text = before.join("") + cut(r.at(-1) ?? "", Math.max(1, room - used));
        return head ? dim(text) : text;
      };
      return capture((output) =>
        log.message(
          // Columns past the terminal width wrap here, behind the guide, instead of at the terminal's column 0
          rows.flatMap((r, i) => wrapAnsi(line(r, i === 0), room, { hard: true, trim: false }).split("\n")),
          { output, spacing: space },
        ),
      );
    }
    case "cards": {
      // The badge leads the title, and the body and sources sit 2 columns deeper (so a body line cannot pass for a status line)
      const items = b.items.map((c) => {
        const badge = c.badge
          ? fancy
            ? `${styleText("inverse", ` ${cell(c.badge)} `)} `
            : `[${cell(c.badge)}] `
          : "";
        return [
          fancy ? `${badge}${bold(cell(c.title))}` : `${badge}${cell(c.title)}`,
          ...(c.body
            ? clean(c.body)
                .split("\n")
                .map((l) => `  ${l}`)
            : []),
          ...(c.meta ?? []).map((m) => `  ${fancy ? dim(cell(m)) : cell(m)}`),
        ];
      });
      if (!fancy) return content(items.flat());
      return items.map((lines, i) => content(lines, i === 0 ? space : 1)).join("\n");
    }
    case "fields": {
      const w = Math.max(...b.rows.map(([k]) => stringWidth(cell(k))));
      return content(
        b.rows.map(([k, v]) =>
          fancy ? `${dim(padTo(cell(k), w + 3))}${bold(cell(v))}` : `${cell(k)}  ${cell(v)}`,
        ),
        space,
      );
    }
    case "meter": {
      if (!fancy) return content([`${cell(b.label)}  ${cell(b.text)}`]);
      // The bar shrinks to the terminal width (a fixed width pushes the bar onto the next line in narrow terminals)
      const bar = Math.max(
        8,
        Math.min(30, columns() - GUIDE - stringWidth(cell(b.label)) - stringWidth(cell(b.text)) - 4),
      );
      const filled = Math.round(Math.max(0, Math.min(1, b.ratio)) * bar);
      return content(
        [
          `${dim(cell(b.label))}  ${"█".repeat(filled)}${dim("░".repeat(bar - filled))}  ${bold(cell(b.text))}`,
        ],
        space,
      );
    }
    case "note": {
      if (!fancy) return content([cell(b.text)]);
      const text = wrapAnsi(cell(b.text), columns() - GUIDE, { hard: true, trim: true });
      return capture((output) => {
        const say = { info: log.info, warning: log.warn, error: log.error, success: log.success }[b.tone];
        say(text, { output });
      });
    }
  }
}

/** One step of a command to run. after is what to do once it has run */
export type Step = { who: string; command: string; after: string | null };

/**
 * Steps of commands to run. Terminals draw a Clack box with each command on its own line (so it can be copied as is).
 * Pipes print an indented list without a box (an AI reads it, and box characters only add length).
 */
export function steps(heading: string, items: Step[], note: string): string {
  // No box when a command does not fit on one line inside it (guide 3, box and padding 6, item indent 2). The box would cut
  // the command at its width and a copy would be partial. The boxless form lets the terminal wrap (a copy stays one line)
  const room = columns() - 11;
  if (!colored() || items.some((x) => stringWidth(x.command) > room))
    return [
      `    ${oneLine(heading)}:`,
      ...items.map((x) => `      ${x.who}: ${x.command}${x.after ? `, then ${x.after}` : ""}`),
      `      ${oneLine(note)}`,
    ].join("\n");
  const body = items
    .flatMap((x) => [bold(x.who), `  ${x.command}`, ...(x.after ? [dim(`  Then: ${x.after}`)] : []), ""])
    .concat(dim(oneLine(note)))
    .join("\n");
  return capture((output) => box(body, oneLine(heading), { output, rounded: true, width: "auto" }));
}
