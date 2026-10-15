import type { BrowserFileChange, BrowserSelection } from "./browser-suite-impact.mjs";
export interface DropshipBrowserPlan {
  run: boolean;
  decisions: (BrowserSelection & { feature: string })[];
  matrix: { include: { feature: string; label: string; shard: number; shards: number }[] };
}
export function fullDropshipBrowserPlan(reason: string): DropshipBrowserPlan;
export function selectDropshipBrowserFeatures(options: {
  changes: readonly BrowserFileChange[];
  files: ReadonlySet<string>;
  readSource: (file: string) => string;
  force?: boolean;
}): DropshipBrowserPlan;
export function runDropshipBrowserSelection(
  environment?: Record<string, string | undefined>, root?: string,
): DropshipBrowserPlan;
