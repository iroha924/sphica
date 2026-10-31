// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

export type ReleaseKind = "none" | "plugin";

export function isPackageInput(file: string): boolean;
export function releaseKind(files: readonly string[]): ReleaseKind;
export function withoutReleaseVersion(text: string | null): string | null;
export const EXACT_PACKAGE_INPUTS: ReadonlySet<string>;
export const PACKAGE_PREFIXES: readonly string[];
export const DEPENDENCY_INPUTS: ReadonlySet<string>;
export type VersionSource = { file: string; pick: (json: unknown) => string | undefined };
export const VERSION_SOURCES: Readonly<Record<"package" | "claude" | "codex" | "marketplace", VersionSource>>;
export const VERSION_FILES: ReadonlySet<string>;
export function releaseVersions(
  read: (file: string) => unknown,
): Record<keyof typeof VERSION_SOURCES, string | undefined>;
