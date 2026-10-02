import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bytes,
  clean,
  ftsQuery,
  head,
  mask,
  privateKeyRanges,
  queryTerms,
  quoteSpan,
  reason,
  tail,
  terms,
  uuidFrom,
} from "../src/text.ts";

// A quote is placed on the masked text only when masking cannot have changed which occurrence it names
test("quoteSpan refuses quotes that masking touched and places the rest on the masked text", () => {
  const span = (raw: string, quote: string) => quoteSpan(raw, mask(raw), quote);
  // The only match left is inside the placeholder
  assert.equal(span("TOKEN=redacted123\n", "redacted"), null);
  // One occurrence was masked away, another survives: the survivor is not the same one
  assert.equal(span("API_KEY=abc123def456\nuse abc123def456 here\n", "abc123def456"), null);
  // Overlapping occurrences count: the key eats the first ones, the tail keeps one
  assert.equal(span(`AIza${"a".repeat(75)}\n`, "a".repeat(40)), null);
  assert.equal(span("API_KEY=abc123def456\n", "abc123def456"), null);
  const raw = "# ops\nAPI_KEY=abc123def456\nBack up before a release.\n";
  const masked = mask(raw);
  assert.notEqual(masked, raw);
  const got = span(raw, "Back up before a release.");
  assert.ok(got);
  assert.equal(Buffer.from(masked).subarray(got[0], got[1]).toString(), "Back up before a release.");
  // Unmasked text keeps the first match, as before
  assert.deepEqual(quoteSpan("a b a", "a b a", "a"), [0, 1]);
  assert.equal(quoteSpan("abc", "abc", ""), null);
});

// A whole cited file can hold a placeholder on every line; the check must stay linear in its length
test("quoteSpan and privateKeyRanges stay fast on a file masked on every line", () => {
  const raw = "TOKEN=abc123def456\n".repeat(100_000);
  const masked = mask(raw);
  const started = performance.now();
  assert.deepEqual(quoteSpan(raw, masked, "TOKEN"), [0, 5]);
  assert.equal(quoteSpan(raw, masked, "TOKEN=[redacted]\nTOKEN"), null);
  const keys = "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n".repeat(20_000);
  assert.equal(privateKeyRanges(keys).length, 20_000);
  // Unclosed placeholder openings in the file itself must not make the placeholder scan reread to the end
  const open = `API_KEY=abc123def456\n${"[redacted: \n".repeat(100_000)}`;
  assert.deepEqual(quoteSpan(open, mask(open), "API_KEY"), [0, 7]);
  assert.ok(performance.now() - started < 5000, `took ${Math.round(performance.now() - started)} ms`);
});

test("privateKeyRanges gives the byte ranges mask() replaces", () => {
  const key = "-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY-----";
  const text = `日本語\n${key}\ntail`;
  const got = privateKeyRanges(text);
  assert.equal(got.length, 1);
  const [a, b] = got[0] ?? [0, 0];
  assert.equal(Buffer.from(text).subarray(a, b).toString(), key);
  assert.equal(mask(text), "日本語\n[redacted: private key]\ntail");
  assert.deepEqual(privateKeyRanges("-----BEGIN PRIVATE KEY-----\nno end"), []);
});

// Hiragana-only words (particles, auxiliaries, and the like) match every row and dilute lexical ranking.
test("terms split Japanese into words and drop hiragana-only words", () => {
  const got = terms("私はなんて言ってた？埋め込みの再ランクを試した");
  for (const w of ["私", "埋", "込", "再", "ランク"])
    assert.ok(got.includes(w), `${w} is missing: ${got.join(",")}`);
  for (const w of ["は", "なんて", "の", "を", "た", "め"]) assert.ok(!got.includes(w), `${w} remains`);
  // Import and query produce the same terms (a different dictionary on one side would miss).
  assert.deepEqual(terms("埋め込み"), terms("埋め込みの"));
});

// Conjugated verbs and English plurals meet their other forms on both sides
test("kanji words drop trailing kana and English plurals become singular", () => {
  assert.deepEqual(terms("入れる"), terms("入れない"));
  assert.deepEqual(terms("package managers"), terms("package manager"));
  for (const w of ["status", "class", "analysis"]) assert.deepEqual([...new Set(terms(w))], [w]);
  const pairs: [string, string][] = [
    ["policies", "policy"],
    ["classes", "class"],
    ["statuses", "status"],
    ["boxes", "box"],
    ["branches", "branch"],
    ["pushes", "push"],
    ["notes", "note"],
    ["cases", "case"],
    ["caches", "cache"],
    ["causes", "cause"],
    ["houses", "house"],
    ["cookies", "cookie"],
  ];
  for (const [plural, one] of pairs) assert.deepEqual(terms(plural), terms(one), `${plural} meets ${one}`);
});

// A question's framing words never decide whether a record answers it
test("query terms drop question framing and keep each subject word once", () => {
  assert.deepEqual(queryTerms("which CI provider do we use"), ["ci", "provider"]);
  // Question words are dropped in the form terms() folds them to, so "does" is not left behind as "doe"
  assert.deepEqual(queryTerms("what does sanitize do"), ["sanitize"]);
  assert.deepEqual(queryTerms("DB サーバーを使わない理由"), ["db", "サーバー", "使"]);
});

// Segmenter splits `docs.ts` and `OT-123`. Questions with ids only match on the whole token.
test("identifiers also become whole terms", () => {
  const got = terms("server/src/db.ts の search_path と OT-123 と #27");
  for (const w of ["server/src/db.ts", "search_path", "ot-123", "#27"])
    assert.ok(got.includes(w), `${w} is missing: ${got.join(",")}`);
});

test("camelCase and snake_case identifiers also give their parts, and names such as SQLite stay whole", () => {
  const got = terms(
    "connectReader と __MAX_COVER_UPLOAD_BYTES と XMLHttpRequest と getUsers と SQLiteVersion",
  );
  for (const w of [
    "connectreader",
    "connect",
    "reader",
    "upload",
    "byte",
    "xmlhttp",
    "request",
    "user",
    "sqlite",
    "version",
  ])
    assert.ok(got.includes(w), `${w} is missing: ${got.join(",")}`);
  assert.ok(!got.includes("sq") && !got.includes("lite"), got.join(","));
  assert.deepEqual(terms("SQLite"), ["sqlite", "sqlite"]);
  // A one-letter part is not a term; an ASCII tail of a Unicode word is not a name; base64 mixes letters and digits inside a part
  assert.ok(!terms("iPhone").includes("i"));
  assert.ok(!terms("naïveReader").includes("ve"));
  // Japanese text right after a name ends it
  for (const w of ["connect", "reader", "cover", "upload"])
    assert.ok(terms("connectReaderを使う。MAX_COVER_UPLOAD_BYTESは上限").includes(w), w);
  assert.deepEqual(terms("aGVsbG8gd29ybGQgaGVsbG8"), ["agvsbg8gd29ybgqgagvsbg8", "agvsbg8gd29ybgqgagvsbg8"]);
  // A question names an identifier once, whole
  assert.deepEqual(queryTerms("connectReader"), ["connectreader"]);
});

test("a 1 MiB run of letters is split in linear time (sources hold file excerpts that size)", () => {
  for (const s of ["a".repeat(1 << 20), "aB".repeat(1 << 19), `x${"_a".repeat(1 << 19)}`]) {
    const t0 = performance.now();
    terms(s);
    assert.ok(performance.now() - t0 < 1000, `took ${Math.round(performance.now() - t0)} ms`);
  }
});

test("normalizes full-width and uppercase", () => {
  assert.deepEqual(terms("ＡＢＣ"), terms("abc"));
});

// Unquoted, AND, NEAR, :, and - are read as FTS5 operators, and user text changes the query syntax.
test("FTS5 queries quote each term and double inner quotes", () => {
  assert.equal(ftsQuery("sql:live"), '"sql:live" OR "sql" OR "live"');
  for (const q of ['AND NEAR NOT x" -y *z', 'say "hi"', "col:1 (a) {b}"])
    for (const w of ftsQuery(q)?.split(" OR ") ?? []) assert.match(w, /^"(?:[^"]|"")+"$/, `${q}: ${w}`);
});

test("a question without terms is not searched", () => {
  assert.equal(ftsQuery("のはを"), null);
  assert.equal(ftsQuery("   "), null);
});

// Resending in capture relies on the same conversation or message mapping to the same row.
test("deterministic UUIDs are equal for equal parts and have the version 8 form", () => {
  const a = uuidFrom("1", "claude-code", "session");
  assert.equal(a, uuidFrom("1", "claude-code", "session"));
  assert.notEqual(a, uuidFrom("1", "claude-code", "session2"));
  // Without a separator, ("ab","c") and ("a","bc") would be equal.
  assert.notEqual(uuidFrom("ab", "c"), uuidFrom("a", "bc"));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("cuts by bytes without splitting a character", () => {
  const s = "あいう🙂えお";
  assert.equal(head(s, 4), "あ");
  assert.ok(bytes(head(s, 13)) <= 13);
  assert.equal(tail(s, 6), "えお");
  assert.equal(head("abc", 10), "abc");
});

test("drops NUL (SQLite length and substr stop at NUL)", () => {
  assert.equal(clean(`a${String.fromCharCode(0)}b`), "ab");
});

test("the error reason includes the reasons of inner errors (AggregateError errors and cause)", () => {
  // pg returns an AggregateError with an empty message when connections to every address are refused.
  const refused = new AggregateError([
    new Error("connect ECONNREFUSED ::1:1"),
    new Error("connect ECONNREFUSED 127.0.0.1:1"),
  ]);
  assert.equal(reason(refused), "connect ECONNREFUSED ::1:1 / connect ECONNREFUSED 127.0.0.1:1");
  // fetch keeps the real reason only in cause.
  const fetchFailed = new Error("fetch failed", {
    cause: new Error("getaddrinfo ENOTFOUND api.example.com"),
  });
  assert.equal(reason(fetchFailed), "fetch failed (getaddrinfo ENOTFOUND api.example.com)");
  assert.equal(reason(new Error("キーが無い")), "キーが無い");
  assert.equal(reason(new Error("")), "unknown failure");
  // With an empty message, use the error name and join only the inner errors that have reasons.
  const timeout = new Error("");
  timeout.name = "TimeoutError";
  assert.equal(reason(timeout), "TimeoutError");
  assert.equal(reason(new AggregateError([new Error(""), new Error("b")])), "b");
  assert.equal(reason(new AggregateError([], "", { cause: new Error("c") })), "c");
  assert.equal(reason(new AggregateError([])), "unknown failure");
  assert.equal(reason(Object.create(null)), "unknown failure");
  // Stops even for an error that is its own cause.
  const loop = new Error("a");
  loop.cause = loop;
  assert.equal(reason(loop), "a (a (a (a)))");
  assert.equal(reason("文字列"), "文字列");
});
