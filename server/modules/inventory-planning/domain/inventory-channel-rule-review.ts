/** The planner fields this classification reads (structurally satisfied by
 * InventoryChannelExposureRuntimePlan["targets"]). */
interface PlannerIssue { readonly code: string; readonly message: string }
export interface ChannelRulePlanTarget {
  readonly publicationTargetId: number;
  readonly channelName: string;
  readonly blockers: readonly PlannerIssue[];
  readonly rows: readonly {
    readonly productVariantId: number;
    readonly sku: string | null;
    readonly blockers: readonly PlannerIssue[];
    readonly warnings: readonly PlannerIssue[];
  }[];
}

export interface ChannelRuleIssueClassification {
  /** Present with the rule, absent without it: the rule creates these. They block Apply. */
  introduced: string[];
  /** Present with and without the rule: not caused by it. Shown, never enforced. */
  existing: string[];
  /** Conservative-quantity notices (ATP projection warnings). They never block:
   * the stock-change worker publishes the same rows with or without the rule. */
  notices: string[];
}

/**
 * Splits planner problems for one product into the ones a single rule would
 * create and the ones already there (owner decision 2026-11-07: an unrelated
 * broken listing must not block saving one SKU rule).
 *
 * A problem's identity is its destination, its SKU (or the destination itself)
 * and its code. Message text is display only, so rewording a message can never
 * turn an existing problem into a new one or the reverse. Pure: same plans in,
 * same result out.
 */
export function classifyChannelRuleIssues(
  before: readonly ChannelRulePlanTarget[],
  after: readonly ChannelRulePlanTarget[],
): ChannelRuleIssueClassification {
  const existingKeys = new Set(issueEntries(before).map(entry => entry.key));
  const introduced = new Map<string, string>();
  const existing = new Map<string, string>();
  for (const entry of issueEntries(after)) (existingKeys.has(entry.key) ? existing : introduced).set(entry.key, entry.message);
  const notices = after.flatMap(target => target.rows.flatMap(row => row.warnings
    .map(warning => `${target.channelName} / ${rowLabel(row)}: ${warning.message}`)));
  return { introduced: unique(introduced.values()), existing: unique(existing.values()), notices: unique(notices) };
}

function issueEntries(targets: readonly ChannelRulePlanTarget[]): Array<{ key: string; message: string }> {
  return targets.flatMap(target => [
    ...target.blockers.map(issue => ({
      key: `${target.publicationTargetId}:destination:${issue.code}`,
      message: `${target.channelName}: ${issue.message}`,
    })),
    ...target.rows.flatMap(row => row.blockers.map(issue => ({
      key: `${target.publicationTargetId}:${row.productVariantId}:${issue.code}`,
      message: `${target.channelName} / ${rowLabel(row)}: ${issue.message}`,
    }))),
  ]);
}

function rowLabel(row: ChannelRulePlanTarget["rows"][number]): string {
  return row.sku ?? `SKU #${row.productVariantId}`;
}

/** Several destinations of one channel can share a message; show it once. */
function unique(messages: Iterable<string>): string[] {
  return [...new Set(messages)];
}
