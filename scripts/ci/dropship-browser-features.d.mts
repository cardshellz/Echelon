export interface DropshipBrowserFeature {
  readonly label: string;
  readonly tests: readonly string[];
  readonly roots: readonly string[];
  readonly shards: number;
}
export const DROPSHIP_BROWSER_FEATURES: Readonly<Record<string, DropshipBrowserFeature>>;
export const DROPSHIP_BROWSER_TEST_PATTERN: RegExp;
export function dropshipFeatureTestMatch(name: string): RegExp[];
export function validateDropshipFeatureCoverage(
  files: ReadonlySet<string>, features?: Readonly<Record<string, DropshipBrowserFeature>>,
): void;
