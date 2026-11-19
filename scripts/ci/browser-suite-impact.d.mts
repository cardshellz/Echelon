import type { ImpactSnapshot, DependencyCache } from "./test-impact.mjs";
export interface BrowserSuiteDefinition {
  config: string;
  workflow: string;
  tests: RegExp;
  roots: string[];
  appRoutes?: readonly string[];
  ownedPrefixes: string[];
  isolated?: boolean;
}

export interface BrowserFileChange {
  status: string;
  paths: string[];
}

export interface BrowserSelection {
  run: boolean;
  reason: string;
}

export const BROWSER_SUITES: Record<"appBootstrap" | "orderEdits" | "procurement" | "procurementConnected" | "dropship", BrowserSuiteDefinition>;

export function parseChangedFiles(output: string): BrowserFileChange[];

export function dependencyClosure(
  roots: readonly string[],
  files: ReadonlySet<string>,
  readSource: (file: string) => string,
  edges?: Map<string, string[]>,
): Set<string>;

export function selectBrowserSuite(options: {
  suite: string;
  changes: readonly BrowserFileChange[];
  files: ReadonlySet<string>;
  readSource: (file: string) => string;
  force?: boolean;
  definitions?: Readonly<Record<string, BrowserSuiteDefinition>>;
  previous?: ImpactSnapshot;
  dependencyCache?: DependencyCache;
}): BrowserSelection;

export function runSelection(
  environment?: Record<string, string | undefined>,
  root?: string,
): BrowserSelection;

export { readTestChangeEvidence as readBrowserChangeEvidence } from "./test-impact.mjs";
