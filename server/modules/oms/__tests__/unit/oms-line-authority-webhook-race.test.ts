import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deriveOmsLineAuthority } from "../../oms-line-authority";

/**
 * Regression: concurrent orders/paid + orders/updated webhook race that dropped
 * paid line items (order #59930, 2026-07-05).
 *
 * Sequence proven from oms_order_line_authority_events:
 *   - orders/paid authorized all 3 lines (paid_quantity 0 -> 1).
 *   - a near-simultaneous orders/updated, whose handler had loaded each line's
 *     authority BEFORE orders/paid committed (previous_paid_quantity = 0), wrote
 *     that stale value back. orders/updated is non-authorizing, so its recompute
 *     is min(previous, observed) = min(0, 1) = 0 -> reverted the line to `seen`.
 *   - `seen` lines have authority_fulfillable_quantity 0, so wms-sync skips them
 *     and they never reach WMS / ShipStation.
 *
 * Fix: the orders/updated matched-line handler re-reads the line FOR UPDATE
 * INSIDE the transaction and derives authority from that fresh, row-locked
 * value, so a concurrent authorizing write can no longer be clobbered.
 */

const AUTHORITY_SRC = readFileSync(
  resolve(__dirname, "../../oms-line-authority.ts"),
  "utf8",
);
const WEBHOOKS_SRC = readFileSync(
  resolve(__dirname, "../../oms-webhooks.ts"),
  "utf8",
);
const OMS_SERVICE_SRC = readFileSync(
  resolve(__dirname, "../../oms.service.ts"),
  "utf8",
);

describe("oms-line-authority — non-authorizing events must not downgrade a fresh authorization", () => {
  it("orders/updated with FRESH previous (authorized) preserves authorization — the fix's premise", () => {
    // With the row re-read, `previous` reflects the committed orders/paid write.
    const authority = deriveOmsLineAuthority({
      sourceTopic: "orders/updated",
      sourceEventId: "webhook_inbox:test",
      sourceInboxId: 1,
      financialStatus: "paid",
      quantity: 1,
      fulfillableQuantity: 1,
      previous: {
        paidQuantity: 1,
        authorityFulfillableQuantity: 1,
        authorizationStatus: "authorized",
        authorizedAt: null,
        authorizedByEventId: null,
      },
    });
    expect(authority.paidQuantity).toBe(1);
    expect(authority.authorityFulfillableQuantity).toBe(1);
    expect(authority.authorizationStatus).toBe("authorized");
  });

  it("orders/updated with STALE previous (seen) reverts to seen — reproduces the #59930 clobber", () => {
    // This is what the old code did: it passed the pre-paid snapshot as previous.
    const authority = deriveOmsLineAuthority({
      sourceTopic: "orders/updated",
      sourceEventId: "webhook_inbox:test",
      sourceInboxId: 1,
      financialStatus: "paid",
      quantity: 1,
      fulfillableQuantity: 1,
      previous: {
        paidQuantity: 0,
        authorityFulfillableQuantity: 0,
        authorizationStatus: "seen",
        authorizedAt: null,
        authorizedByEventId: null,
      },
    });
    // Non-authorizing branch: min(previous=0, observed=1) = 0 -> seen.
    expect(authority.paidQuantity).toBe(0);
    expect(authority.authorizationStatus).toBe("seen");
  });

  it("orders/paid authorizes a seen line regardless of previous (authorizing branch)", () => {
    const authority = deriveOmsLineAuthority({
      sourceTopic: "orders/paid",
      sourceEventId: "webhook_inbox:test",
      sourceInboxId: 1,
      financialStatus: "paid",
      quantity: 1,
      fulfillableQuantity: 1,
      previous: {
        paidQuantity: 0,
        authorityFulfillableQuantity: 0,
        authorizationStatus: "seen",
        authorizedAt: null,
        authorizedByEventId: null,
      },
    });
    expect(authority.paidQuantity).toBe(1);
    expect(authority.authorizationStatus).toBe("authorized");
  });

  it("orders/updated is intentionally NOT an authorizing topic", () => {
    // The whole failure mode depends on this: orders/updated cannot re-authorize
    // a line, so the ONLY protection against the race is deriving from fresh
    // committed state. If orders/updated ever becomes authorizing, revisit this.
    const authorizingBlock = AUTHORITY_SRC.slice(
      AUTHORITY_SRC.indexOf("AUTHORIZING_TOPICS"),
      AUTHORITY_SRC.indexOf("AUTHORIZING_TOPICS") + 400,
    );
    expect(authorizingBlock).toContain('"orders/paid"');
    expect(authorizingBlock).not.toContain('"orders/updated"');
  });
});

describe("oms.service duplicate ingest", () => {
  it("derives authority from a row-locked fresh read before updating an existing line", () => {
    // Production regression: paid Shopify orders #60237/#60238/#60279/#60286
    // were authorized by orders/paid, then concurrent orders/updated duplicate
    // ingest wrote stale previous_paid_quantity=0 back over the line authority.
    const marker = "const previousAuthority = lockedLine ?? existingLine";
    const idx = OMS_SERVICE_SRC.indexOf(marker);
    expect(idx).toBeGreaterThan(-1);
    const block = OMS_SERVICE_SRC.slice(idx - 350, idx + 3600);

    expect(block).toContain(".for(\"update\")");
    expect(block).toContain(marker);
    expect(block).toContain("buildLineAuthorityState(data, item, previousAuthority)");
    expect(block).toContain("previous: previousAuthority");
    expect(block).not.toContain("buildLineAuthorityState(data, item, existingLine)");
  });
});

describe("oms-webhooks — matched-line update derives authority from a row-locked fresh read", () => {
  it("re-reads the line FOR UPDATE inside the transaction and uses it as `previous`", () => {
    // Structural guard: the derive + write must run AFTER a FOR UPDATE re-read,
    // not from the pre-transaction `existingLine` snapshot.
    const marker = "RACE FIX (order #59930)";
    const idx = WEBHOOKS_SRC.indexOf(marker);
    expect(idx).toBeGreaterThan(-1);
    const block = WEBHOOKS_SRC.slice(idx, idx + 3400);
    // Locked re-read inside the transaction, before the derive.
    expect(block).toContain(".for(\"update\")");
    expect(block).toContain("const previousAuthority = lockedLine ?? existingLine");
    // Authority is derived from the fresh read, and the ledger records it too.
    expect(block).toContain("previous: previousAuthority");
    // The derive must occur inside db.transaction (after the lock), not before.
    const txnIdx = block.indexOf("db.transaction");
    const deriveIdx = block.indexOf("deriveOmsLineAuthority({");
    expect(txnIdx).toBeGreaterThan(-1);
    expect(deriveIdx).toBeGreaterThan(txnIdx);
  });
});
