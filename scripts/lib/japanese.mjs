// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The Japanese character test, with no dependencies (the commit message check runs before dependencies are installed).

/** Kana (with the shared middle dot U+30FB and long vowel mark U+30FC), kanji, CJK punctuation (U+3000-U+303F), and full-width forms (U+FF00-U+FFEF). */
export const JAPANESE =
  /[\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script=Han}\u3000-\u303f\uff00-\uffef]/u;
