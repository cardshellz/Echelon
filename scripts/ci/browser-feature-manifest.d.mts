export type BrowserFeatureSuite = "inventory" | "returns";
export interface BrowserFeature { label: string; shards: number; tests: string[]; roots: string[]; }
export const BROWSER_FEATURES: Readonly<Record<BrowserFeatureSuite, Record<string, BrowserFeature>>>;
export const BROWSER_CONFIGS: Readonly<Record<BrowserFeatureSuite, { config: string; workflow: string; shards: number }>>;
export function browserFeatureTestMatch(suite: BrowserFeatureSuite, feature?: string): RegExp[] | undefined;
export function validateBrowserFeatures(suite: BrowserFeatureSuite, files: ReadonlySet<string>): Set<string>;
