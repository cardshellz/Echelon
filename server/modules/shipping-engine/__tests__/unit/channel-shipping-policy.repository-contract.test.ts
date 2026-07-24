import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(
    process.cwd(),
    "server/modules/shipping-engine/infrastructure/channel-shipping-policy.repository.ts",
  ),
  "utf8",
);

describe("channel shipping policy repository contract", () => {
  it("runs lifecycle commands through a database transaction", () => {
    expect(source).toContain("return db.transaction((tx) => work(");
    expect(source).toContain("persistAuditEvent(this.tx");
  });

  it("locks the channel before the policy for every policy command", () => {
    const method = source.slice(
      source.indexOf("async getPolicyForUpdate("),
      source.indexOf("async findDraftPolicy("),
    );
    const channelLock = method.indexOf("FROM channels.channels");
    const policyLock = method.indexOf("FROM shipping.channel_policies");

    expect(channelLock).toBeGreaterThan(-1);
    expect(policyLock).toBeGreaterThan(channelLock);
    expect(method.match(/FOR UPDATE/g)).toHaveLength(2);
  });

  it("uses compare-and-swap guards for draft and lifecycle mutations", () => {
    expect(source).toContain(
      "eq(shippingChannelPolicies.lockVersion, input.expectedLockVersion)",
    );
    expect(source).toContain(
      "sql`${shippingChannelPolicies.lockVersion} + 1`",
    );
    expect(source).toContain(
      "eq(shippingDestinationScopes.lockVersion, input.expectedLockVersion)",
    );
  });

  it("freezes route destinations instead of resolving mutable scopes at runtime", () => {
    expect(source).toContain(".insert(shippingChannelPolicyRouteDestinations)");
    expect(source).toContain(
      "shippingChannelPolicyRouteDestinations.destinationCountry",
    );
    expect(source).not.toContain("store_connection_id");
    expect(source).not.toContain("vendor_id");
  });

  it("persists shadow comparisons in the existing quote evidence table", () => {
    expect(source).toContain(".insert(shippingQuoteSnapshots)");
    expect(source).toContain('source: "shadow"');
    expect(source).toContain('kind: "channel_policy_decision"');
  });

  it("contains no guessed channel identifiers", () => {
    expect(source).not.toMatch(/\b(?:36|37|67|103)\b/);
  });
});
