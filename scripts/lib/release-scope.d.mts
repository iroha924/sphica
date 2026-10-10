// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

export type ReleaseKind = "none" | "plugin";

export function isPackageInput(file: string): boolean;
export function releaseKind(files: readonly string[]): ReleaseKind;
export function withoutReleaseVersion(text: string | null): string | null;
export const EXACT_PACKAGE_INPUTS: ReadonlySet<string>;
export const PACKAGE_PREFIXES: readonly string[];
