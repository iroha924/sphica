// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

export function commentMarker(file: string): "//" | "--" | null;
export function headerLines(marker: string): [string, string];
export function headerProblem(source: string, marker: string): string | null;
export function withHeader(source: string, marker: string): string;
export function sourceFiles(root: string, skip: RegExp): string[];
