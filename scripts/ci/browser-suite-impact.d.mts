export interface BrowserSuiteDefinition {
  config: string;
  workflow: string;
  tests: RegExp;
  roots: string[];
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

export const BROWSER_SUITES: Record<"orderEdits" | "procurement" | "dropship", BrowserSuiteDefinition>;

export function parseChangedFiles(output: string): BrowserFileChange[];

export function dependencyClosure(
  roots: readonly string[],
  files: ReadonlySet<string>,
  readSource: (file: string) => string,
): Set<string>;

export function selectBrowserSuite(options: {
  suite: string;
  changes: readonly BrowserFileChange[];
  files: ReadonlySet<string>;
  readSource: (file: string) => string;
  force?: boolean;
  definitions?: Readonly<Record<string, BrowserSuiteDefinition>>;
}): BrowserSelection;

export function runSelection(
  environment?: Record<string, string | undefined>,
  root?: string,
): BrowserSelection;

export function readBrowserChangeEvidence(environment: Record<string, string | undefined>, root: string): {
  changes: BrowserFileChange[];
  files: Set<string>;
  readSource: (file: string) => string;
};
