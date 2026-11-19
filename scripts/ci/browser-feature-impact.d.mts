import type { ChangeEvidence, ImpactDecision } from "./test-impact.mjs";
import type { BrowserFeatureSuite } from "./browser-feature-manifest.mjs";
export interface BrowserFeaturePlan {
  run: boolean; decisions: Array<ImpactDecision & { feature: string }>;
  matrix: { include: Array<{ feature: string; shard: number; shards: number }> };
}
export function fullBrowserFeaturePlan(suite: BrowserFeatureSuite, reason: string): BrowserFeaturePlan;
export function selectBrowserFeatures(suite: BrowserFeatureSuite, evidence: ChangeEvidence): BrowserFeaturePlan;
export function runBrowserFeatureSelection(environment?: Record<string, string | undefined>, root?: string): BrowserFeaturePlan;
