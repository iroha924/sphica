// String preparation: splitting terms, full-text queries, hashes, deterministic ids, and cutting by bytes.
//
// **SQLite does not split terms.** FTS5's default tokenizer cannot split Japanese into words, so the index side (sphica_terms,
// called by database triggers and registered in server/src/db-write.ts) and the query side go through the same function (terms).
// With the same splitting on both sides, dictionary differences never shift terms on one side only.

import crypto from "node:crypto";

const segmenter = new Intl.Segmenter("ja", { granularity: "word" });

// Hiragana-only terms are particles, auxiliaries, and similar function words; they match every row and dilute ranking.
// english-exempt: the long vowel mark appears inside hiragana-only words, which must be treated alike
const HIRAGANA_ONLY = /^[\p{Script=Hiragana}ー]+$/u;
const STOP = new Set(["the", "a", "an", "of", "to", "in", "is", "and", "or", "for", "on", "it", "be"]);
// Identifiers the Segmenter splits (file names, snake_case, OT-123, #27) are also kept whole as terms.
const IDENT = /#\d+|[a-z0-9][a-z0-9_./#-]*[a-z0-9]/g;
// Overly long chunks are not terms (base64 or hashes).
const MAX_TERM = 100;
// A kanji word with trailing kana (a conjugated verb) is kept as its kanji, so its conjugated forms meet.
// english-exempt: the long vowel mark is kana too
const OKURIGANA = /^(\p{Script=Han}+)[\p{Script=Hiragana}ー]+$/u;

/**
 * An English word and its plural brought to one form, so both meet: managers and manager, policies and policy, classes and class. Where a plural
 * is ambiguous (caches and branches both end in -ches) the singular is folded the same way (cache and caches both become cach).
 */
function singular(w: string): string {
  if (!/^[a-z]{4,}$/.test(w)) return w;
  if (w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.endsWith("ie")) return `${w.slice(0, -2)}y`;
  if (/(?:ss|us|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (/(?:ch|sh|us)e$/.test(w)) return w.slice(0, -1);
  return w.endsWith("s") && !/(?:ss|us|is)$/.test(w) ? w.slice(0, -1) : w;
}

/**
 * Returns search terms in order of appearance (with duplicates). Imports and queries use the same function.
 * **Changing the rules leaves existing indexes as they were.** A PR that changes them tells the owner to run `sphica doctor --reindex` in its release steps.
 */
export function terms(text: string): string[] {
  const norm = text.normalize("NFKC").toLowerCase();
  const out: string[] = [];
  const keep = (w: string) => {
    if (w.length > MAX_TERM || STOP.has(w) || HIRAGANA_ONLY.test(w)) return;
    out.push(OKURIGANA.exec(w)?.[1] ?? singular(w));
  };
  for (const s of segmenter.segment(norm)) if (s.isWordLike) keep(s.segment.trim());
  for (const m of norm.matchAll(IDENT)) if (m[0].length >= 3) keep(m[0]);
  return out.filter(Boolean);
}

/**
 * Words that frame a question rather than name its subject ("why", "which", and their Japanese counterparts). Dropped from queries only, so a question
 * such as "which CI provider do we use" is judged on "ci" and "provider". Light verbs (use, add, get) go here for the same reason.
 */
const QUESTION = new Set([
  ...[
    "why",
    "what",
    "which",
    "when",
    "where",
    "who",
    "how",
    "do",
    "does",
    "did",
    "we",
    "our",
    "us",
    "you",
    "i",
    "are",
    "was",
    "were",
  ],
  ...[
    "will",
    "would",
    "should",
    "can",
    "could",
    "there",
    "this",
    "that",
    "with",
    "from",
    "any",
    "ever",
    "long",
    "use",
    "used",
    "using",
  ],
  ...["add", "get", "make", "have", "has", "not", "no", "yes", "reason"],
  // english-exempt: Japanese question framing words, matched after splitting
  ...["理由", "仕組", "何", "方", "場合", "今", "件"],
]);

/** A question's content terms: its terms without question framing, each once, in order. */
export function queryTerms(question: string): string[] {
  return [...new Set(terms(question).filter((w) => !QUESTION.has(w)))].slice(0, 24);
}

/**
 * An FTS5 query matching any of the question's terms. null when there are no terms (no search).
 * **Every term is wrapped in `"..."` with inner `"` doubled.** Unwrapped, `AND`, `NEAR`, `*`, `:`, and `-` would be read as FTS5
 * operators and the user's text would change the query syntax (`sql:live` would become a column filter).
 */
export function ftsQuery(question: string): string | null {
  const ws = queryTerms(question);
  return ws.length ? ws.map((w) => `"${w.replaceAll('"', '""')}"`).join(" OR ") : null;
}

export const sha256 = (s: string): Buffer => crypto.createHash("sha256").update(s).digest();

/**
 * A UUID built deterministically from parts (RFC 9562 version 8). Sending the same conversation or message twice gives the same id,
 * so resending imports and recordings stays idempotent with just `on conflict do nothing`.
 */
export function uuidFrom(...parts: string[]): string {
  const b = crypto.createHash("sha256").update(parts.join("\u0000")).digest().subarray(0, 16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x80;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

/** Fits the start into n bytes without cutting a character. */
export function head(s: string, n: number): string {
  if (bytes(s) <= n) return s;
  let out = "";
  let used = 0;
  for (const ch of s) {
    const b = bytes(ch);
    if (used + b > n) break;
    out += ch;
    used += b;
  }
  return out;
}

/** Fits the end into n bytes. */
export function tail(s: string, n: number): string {
  if (bytes(s) <= n) return s;
  const chars = [...s];
  let used = 0;
  let i = chars.length;
  while (i > 0) {
    const b = bytes(chars[i - 1] ?? "");
    if (used + b > n) break;
    used += b;
    i--;
  }
  return chars.slice(i).join("");
}

/** SQLite length and substr stop reading at NUL (titles get cut). Outside strings go through here before storing. */
export const clean = (s: string): string => s.replaceAll("\u0000", "");

/**
 * Drops characters Unicode treats as invisible by default (Default_Ignorable_Code_Point: tag characters, zero-width, bidi controls)
 * so models are never fed text people cannot see. ZWJ and ZWNJ, needed to join characters, and variation selectors for emoji stay
 * (tag-sequence flags and soft hyphens break, but dropping wins). The kept characters can still carry text when lined up; the guard
 * against that is the framed tag.
 */
export const visible = (s: string): string =>
  s.replace(/(?!\p{Join_Control}|\p{Variation_Selector})\p{Default_Ignorable_Code_Point}/gu, "");

// Pasted keys never enter the database or the queue. **Only what is recognizable by shape is masked** (no guessing away text).
// Five shapes: keys with known prefixes, assignments to key names (KEY=… / "password": "…"), credentials in URLs, auth header values,
// and `mysql -p` passwords. Keys in other formats are not masked. Not pasting comes first; this is a net that catches some misses.
// **Every pattern stays linear in the input length.** The hook passes messages up to 128 KiB and trace passes unbounded text.
// Quantifiers are never adjacent (competing for the same characters goes quadratic). Matching never starts mid-word (`eyJ-eyJ-…` goes quadratic).
const SECRETS: [RegExp, string][] = [
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/g, "API key"],
  [/\b[srp]k_(?:live|test)_[A-Za-z0-9]{16,}/g, "API key"],
  [/\bwhsec_[A-Za-z0-9+/=]{16,}/g, "webhook signing secret"],
  [/\bpa-[A-Za-z0-9_-]{20,}/g, "API key"],
  [/\bAIza[0-9A-Za-z_-]{35}/g, "API key"],
  [/\bnpg_[A-Za-z0-9]{12,}/g, "database password"],
  [/\bnapi_[A-Za-z0-9]{30,}/g, "API key"],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, "npm token"],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, "GitLab token"],
  // Installation tokens may be stateless: a ghs_-prefixed JWT with dots, hyphens, and underscores, up to about 520 characters.
  // GitHub tokens start after any non-alphanumeric, including the underscore of Markdown emphasis, which \b would miss
  [/(?<![A-Za-z0-9])ghs_[A-Za-z0-9._-]{36,}/g, "GitHub token"],
  [/(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{30,}/g, "GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}/g, "GitHub token"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "Slack token"],
  [/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g, "Slack webhook"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "AWS key"],
  [/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "JWT"],
  // Values pasted outside a header. Only a capitalized Bearer with a value containing digits (so "the bearer src/app/v2/route.ts" survives).
  [/\b(?:Bearer|BEARER)\s+(?=[A-Za-z0-9._~+/=-]{0,512}\d)[A-Za-z0-9._~+/=-]{16,}/g, "auth header value"],
];
// Authorization header values. Header, JSON, and code forms (`"Authorization": "Basic …"`) are treated alike.
const AUTH_HEADER =
  /(\bAuthorization["']?\s*[:=]\s*(?:["']\s*)?(?:Bearer|Basic|Token|Digest)\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
// bearer values in headers with other names (`-H "X-Auth: bearer …"`, `{"X-Auth": "bearer …"}`).
const HEADER_BEARER = /(:[ \t]*(?:["'][ \t]*)?bearer[ \t]+)[A-Za-z0-9._~+/=-]{16,}/gi;
// Environment variable form (assignment to an uppercase name). **Values that reference a variable are not masked** (`PASSWORD=$DB_PASSWORD`).
// KEY stands alone or follows a word separator (`_`) or a key word (MASTERKEY). PASS and PWD only follow `_`
// (so MONKEY=banana, COMPASS=north, and the shell's PWD=/Users/… survive).
const ENV_ASSIGN =
  /\b((?:[A-Z][A-Z0-9_]*_)?(?:API|SECRET|MASTER|ENCRYPTION|PRIVATE|ACCESS|SIGNING|AUTH)?KEY|[A-Z][A-Z0-9_]*_(?:PASS|PWD)|(?:[A-Z][A-Z0-9_]*?)?(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?))(\s*=\s*)(?:"(?!\$)[^"\n]+"|'(?!\$)[^'\n]+'|(?![$"'])[^\s"']+)/g;
// Config files, JSON, headers, URLs, and code (names ending in a key word, with `:` `=` `:=` `=>`). Matching starts at the key word
// and ignores the front of the name.
const FIELD_NAME =
  /(?:(?:api|account|access|private|secret)[-_]?key|secret|token|passw(?:or)?d)["']?\s*(?::=|=>|[:=])\s*/gi;
/** Maximum length read as a quoted value. Longer values are not judged. */
const MAX_QUOTED = 4096;
/**
 * Unquoted values are judged as key-like from their first 256 characters, and read to the end only when masked (not reread per key word).
 * The next URL parameter (`&user=…`) is not part of the value. An `&` inside a password (`Xk9&mZ2p`) is.
 */
const BARE_HEAD = /[^\s"',;)]{1,256}/y;
const BARE_REST = /[^\s"',;)]*/y;
const NEXT_PARAM = /&[A-Za-z_][\w.-]*=/;
const bareAt = (re: RegExp, text: string, at: number): string => {
  re.lastIndex = at;
  const v = re.exec(text)?.[0] ?? "";
  const cut = v.search(NEXT_PARAM);
  return cut < 0 ? v : v.slice(0, cut);
};
/**
 * Whether an assigned value looks like a key. **Values attached to key names lean toward masking** (a leak cannot be undone; over-masking only loses a word).
 *   Variable references (`${…}`, `$NAME`) are not masked
 *   Unquoted values: 8 or more characters mixing digits and letters (so `token = getToken()`, `password: string`, `#ff00aa` survive)
 *   Quoted values: 8 or more characters are masked. Exceptions: CSS colors, text without ASCII letters or digits (for example only Japanese), and
 *   sentences with no word mixing digits and letters (`"Password is required"`). Letter-only passphrases separated by spaces also survive, since they look like sentences
 */
function secretValue(quoted: boolean, v: string): boolean {
  if (v.length < 8 || /^\$(?:\{|[A-Za-z_])/.test(v)) return false;
  if (!quoted) return !/^[#$]/.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v) && !/[()]/.test(v);
  if (/^#[0-9a-f]{3,8}$/i.test(v) || !/[A-Za-z0-9]/.test(v)) return false;
  return !/\s/.test(v) || v.split(/\s+/).some((w) => /\d/.test(w) && /[A-Za-z]/.test(w));
}

/**
 * Masks assignments to key names. **Values left unmasked are still scanned** (the key after `?refresh_token=$RT&client_secret=…`,
 * the key inside `"token": "run it with password='…'"`). Masked values are skipped, so the work stays proportional to input length.
 */
function maskFields(text: string): string {
  let out = "";
  let last = 0;
  FIELD_NAME.lastIndex = 0;
  for (let m = FIELD_NAME.exec(text); m; m = FIELD_NAME.exec(text)) {
    const at = m.index + m[0].length;
    const q = text[at];
    let quote = "";
    let value: string;
    if (q === '"' || q === "'") {
      const close = text.indexOf(q, at + 1);
      if (close < 0 || close - at - 1 > MAX_QUOTED) continue;
      value = text.slice(at + 1, close);
      if (value.includes("\n")) continue;
      quote = q;
    } else {
      value = bareAt(BARE_HEAD, text, at);
    }
    if (!secretValue(quote !== "", value)) continue;
    if (!quote && value.length === 256) value += bareAt(BARE_REST, text, at + 256);
    out += `${text.slice(last, at)}${quote}[redacted]`;
    last = at + quote.length + value.length;
    FIELD_NAME.lastIndex = last;
  }
  return out + text.slice(last);
}

// `mysql -p<password>` (only the form with no space after -p carries a password). Only the first -p within the same command (up to
// `&&` `;` `|` and newlines; separators inside quotes do not count, and lines continued with `\` continue) is masked
// (so a later `ssh -p2222` or `cp -pr` survives).
const MYSQL_COMMAND = /\bmysql(?:dump|admin)?\b(?:'[^'\n]*'|"[^"\n]*"|[^\n;&|\\'"]|\\\r?\n|\\(?!\r?\n))*/g;
const MYSQL_PASSWORD = /(\s-p)(?:'[^'\n]*'|"[^"\n]*"|(?=[^\s-])\S+)/;
// URL credentials are masked up to the @ right before the host, even when the password contains @. Where it connected stays as content.
// userinfo appears only before the first `/` (so the port in `http://localhost:5173/@vite` is not masked). Cutting there keeps it linear.
const URL_CREDENTIALS =
  /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?|https?):\/\/[^:\s/@]*:)[^\s/]*@([^@\s/?#]+)/g;
const KEY_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/g;

/**
 * Private key blocks as string index ranges, from a BEGIN to the next END. END positions are collected in one pass first — a lazy regex
 * match would reread to the end for every BEGIN when many BEGINs have no END, going quadratic.
 */
function keyBlocks(text: string): [number, number][] {
  const ends = [...text.matchAll(KEY_END)].map((m) => [m.index, m.index + m[0].length] as const);
  const out: [number, number][] = [];
  let last = 0;
  let e = 0;
  if (ends.length > 0)
    for (const m of text.matchAll(KEY_BEGIN)) {
      const after = m.index + m[0].length;
      if (m.index < last) continue;
      while (e < ends.length && (ends[e]?.[0] ?? 0) < after) e++;
      const end = ends[e];
      if (!end) break;
      out.push([m.index, end[1]]);
      last = end[1];
    }
  return out;
}

function maskPrivateKeys(text: string): string {
  let out = "";
  let last = 0;
  for (const [a, b] of keyBlocks(text)) {
    out += `${text.slice(last, a)}[redacted: private key]`;
    last = b;
  }
  return out + text.slice(last);
}

/** The UTF-8 byte ranges of the private key blocks mask() replaces, so a caller cutting by bytes can tell a cut inside a key. */
export function privateKeyRanges(text: string): [number, number][] {
  return byteRanges(text, keyBlocks(text));
}

/** String index ranges, in order and not overlapping, as UTF-8 byte ranges, counting each stretch once. */
function byteRanges(text: string, ranges: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  let at = 0;
  let pos = 0;
  for (const [a, b] of ranges) {
    pos += bytes(text.slice(at, a));
    const end = pos + bytes(text.slice(a, b));
    out.push([pos, end]);
    at = b;
    pos = end;
  }
  return out;
}

// Labels are short names (the longest is "webhook signing secret"); a bound keeps unclosed openings in a file from rereading to its end
const PLACEHOLDER = /\[redacted(?:: [^\]\n]{1,40})?\]/g;

/** The string index ranges of the placeholders mask() left in masked text, in order. */
export function placeholderRanges(masked: string): [number, number][] {
  return [...masked.matchAll(PLACEHOLDER)].map((x) => [x.index, x.index + x[0].length]);
}

/** Every byte offset where needle starts in hay, overlapping occurrences included. */
function starts(hay: Buffer, needle: Buffer): number[] {
  const out: number[] = [];
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) out.push(at);
  return out;
}

/**
 * The byte span of quote in masked (the masked form of raw), or null when it is missing or masking may have moved it: some occurrence in raw
 * was masked away, or the match touches a placeholder. Each occurrence outside placeholders maps to one in raw, in order, so equal counts
 * mean the first one is the same occurrence.
 */
export function quoteSpan(raw: string, masked: string, quote: string): [number, number] | null {
  const q = Buffer.from(quote, "utf8");
  if (q.length === 0) return null;
  const m = Buffer.from(masked, "utf8");
  if (raw === masked) {
    const at = m.indexOf(q);
    return at < 0 ? null : [at, at + q.length];
  }
  const holes = byteRanges(masked, placeholderRanges(masked));
  // Matches and placeholders both run in order, so one pass pairs them
  let h = 0;
  const kept = starts(m, q).filter((at) => {
    while ((holes[h]?.[1] ?? Number.POSITIVE_INFINITY) <= at) h++;
    return !((holes[h]?.[0] ?? Number.POSITIVE_INFINITY) < at + q.length);
  });
  const first = kept[0];
  return first !== undefined && kept.length === starts(Buffer.from(raw, "utf8"), q).length
    ? [first, first + q.length]
    : null;
}

export function mask(text: string): string {
  // Mask assignments, headers, and URLs first (the whole value goes). Then mask the remaining bare keys by shape.
  let out = maskFields(
    maskPrivateKeys(text)
      .replace(URL_CREDENTIALS, "$1[redacted]@$2")
      .replace(AUTH_HEADER, "$1[redacted]")
      .replace(HEADER_BEARER, "$1[redacted]")
      .replace(ENV_ASSIGN, "$1$2[redacted]"),
  ).replace(MYSQL_COMMAND, (command) => command.replace(MYSQL_PASSWORD, "$1[redacted]"));
  for (const [re, what] of SECRETS) out = out.replace(re, `[redacted: ${what}]`);
  return out;
}

/**
 * The reason text of an error, with the reasons of inner errors (AggregateError errors and cause). When every address of a Node
 * connection is refused it returns an AggregateError with an empty message, and fetch keeps the real reason (a DNS failure) only in cause.
 */
export const reason = (e: unknown): string => explain(e, 0) || "unknown failure";

/** A count with its noun: `1 result`, `2 results`. Pass the plural when it is not the singular plus "s". */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The reason text, or an empty string when nothing is known (callers join only the inner errors that are known). */
function explain(e: unknown, depth: number): string {
  if (!(e instanceof Error)) {
    try {
      return String(e);
    } catch {
      return ""; // an object with a null prototype cannot become a string
    }
  }
  // With an empty message, use the error name (TimeoutError and so on). Error and AggregateError say nothing, so they are not used.
  const own = e.message || (e.name === "Error" || e.name === "AggregateError" ? "" : e.name);
  const parts: unknown[] =
    depth >= 3
      ? []
      : [...(e instanceof AggregateError ? e.errors : []), ...(e.cause === undefined ? [] : [e.cause])];
  const inner = parts
    .map((x) => explain(x, depth + 1))
    .filter(Boolean)
    .join(" / ");
  return own && inner ? `${own} (${inner})` : own || inner;
}
