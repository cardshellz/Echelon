import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
  SubscriptionRequestError,
  cancelSubscriptionCommand,
  pauseSubscriptionCommand,
  changeSubscriptionPlanCommand,
  retrySubscriptionBillingCommand,
  runManualBillingPassCommand,
  presentSubscriptionCancelFeedback,
  presentSubscriptionCommandError,
  presentManualBillingFeedback,
} from "../../subscriptions-api";
import {
  DEFAULT_ORDER_EDIT_CODE_MESSAGES,
  OrderEditCodeInputError,
  resolveOrderEditCodeErrorMessage,
} from "@shared/order-edits/order-edit-code-errors";
import { OrderEditRequestError } from "../../order-edits";
import { customerAccountPageConfigSchema } from "../../../customer-account/account-page-config";
import {
  OrderDraft as PageReexportedOrderDraft,
  OrderEditOperationView as PageReexportedOperationView,
} from "../../../pages/OrderEdits";
import {
  OrderDraft as SharedOrderDraft,
  OrderEditOperationView as SharedOperationView,
} from "../../../components/order-edits/OrderEditWorkspace";

function collectStaticImportSpecifiers(filePath: string): string[] {
  const source = fs.readFileSync(filePath, "utf8");
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const specifiers: string[] = [];
  sf.forEachChild((node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
  });
  return specifiers;
}

describe("Priority 13 Batch CUST-1 — Client Safeguards, Coupon Presentation & Shared UI Boundaries (CUST-04, CUST-06, CUST-07)", () => {
  describe("CUST-04: Verified HTTP and command outcomes for Subscriptions admin UI", () => {
    it("rejects HTTP 403, HTTP 500, malformed JSON, and { success: false } responses without reporting success", async () => {
      const forbiddenFetch = vi.fn(async () =>
        new Response(JSON.stringify({ error: "Missing shellz:admin permission" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
      );
      await expect(cancelSubscriptionCommand(42, "Test", forbiddenFetch as any)).rejects.toMatchObject({
        name: "SubscriptionRequestError",
        status: 403,
        code: "PERMISSION_DENIED",
        uncertain: false,
        message: "Missing shellz:admin permission",
      });

      const html502Fetch = vi.fn(async () =>
        new Response("<html>Bad Gateway</html>", {
          status: 502,
          headers: { "Content-Type": "text/html" },
        }),
      );
      await expect(pauseSubscriptionCommand(42, true, html502Fetch as any)).rejects.toMatchObject({
        name: "SubscriptionRequestError",
        status: 502,
        uncertain: true,
      });

      const failedPayloadFetch = vi.fn(async () =>
        new Response(JSON.stringify({ success: false, error: "Plan not found" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      await expect(changeSubscriptionPlanCommand(42, 99, failedPayloadFetch as any)).rejects.toMatchObject({
        name: "SubscriptionRequestError",
        code: "COMMAND_FAILED",
        message: "Plan not found",
      });
    });

    it("surfaces warning/uncertain/lock-contention states distinctly from clean completion", async () => {
      expect(
        presentSubscriptionCancelFeedback({
          success: true,
          providerStatus: "provider_failed",
          warning: "Shopify contract draft commit failed.",
        }),
      ).toEqual({
        title: "Cancelled locally — Shopify confirmation needed",
        description: "Shopify contract draft commit failed.",
        variant: "destructive",
      });

      expect(
        presentSubscriptionCancelFeedback({
          success: true,
          providerStatus: "confirmed",
        }),
      ).toEqual({
        title: "Subscription cancelled",
        description: "Local membership and Shopify contract cancelled.",
      });

      const uncertainFetch = vi.fn(async () =>
        new Response(
          JSON.stringify({
            success: false,
            uncertain: true,
            code: "BILLING_OUTCOME_UNCERTAIN",
            error: "Billing outcome could not be confirmed.",
          }),
          { status: 502, headers: { "Content-Type": "application/json" } },
        ),
      );
      let caughtRetryErr: unknown;
      try {
        await retrySubscriptionBillingCommand(42, uncertainFetch as any);
      } catch (err) {
        caughtRetryErr = err;
      }
      expect(caughtRetryErr).toBeInstanceOf(SubscriptionRequestError);
      expect(presentSubscriptionCommandError(caughtRetryErr, "Retry failed")).toEqual({
        title: "Outcome uncertain — check status before retrying",
        description: "Billing outcome could not be confirmed.",
        variant: "destructive",
      });

      const lockHeldFetch = vi.fn(async () =>
        new Response(
          JSON.stringify({
            success: false,
            skipped: true,
            reason: "billing_lock_held",
            error: "A subscription billing run is already in progress.",
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        ),
      );
      let caughtLockErr: unknown;
      try {
        await runManualBillingPassCommand(lockHeldFetch as any);
      } catch (err) {
        caughtLockErr = err;
      }
      expect(presentSubscriptionCommandError(caughtLockErr, "Billing run failed")).toEqual({
        title: "Billing run already in progress",
        description: "A subscription billing run is already in progress.",
      });

      expect(
        presentManualBillingFeedback({
          success: true,
          processed: 3,
          succeeded: 2,
          failed: 0,
          uncertain: 1,
          errors: ["Subscription 91 uncertain"],
        }),
      ).toEqual({
        title: "Billing run finished with uncertain outcomes",
        description: "Processed: 3, Dispatched: 2, Rejected: 0, Uncertain (locked): 1",
        variant: "destructive",
      });
    });

    it("eliminates raw unverified fetch() calls inside Subscriptions.tsx", () => {
      const subscriptionsPagePath = path.resolve(
        import.meta.dirname,
        "../../../pages/Subscriptions.tsx",
      );
      const source = fs.readFileSync(subscriptionsPagePath, "utf8");
      expect(source).not.toMatch(/\bfetch\s*\(/);
    });
  });

  describe("CUST-06: Coupon public error code + safe parameter presentation contract", () => {
    it("preserves exact default English messages when theme overrides are absent and applies safe overrides when present", () => {
      const cappedCouponError = new OrderEditRequestError(
        DEFAULT_ORDER_EDIT_CODE_MESSAGES.ORDER_EDIT_NATIVE_COUPON_REDEMPTION_UNAVAILABLE,
        "ORDER_EDIT_NATIVE_COUPON_REDEMPTION_UNAVAILABLE",
        409,
        false,
      );
      expect(resolveOrderEditCodeErrorMessage(cappedCouponError)).toBe(
        DEFAULT_ORDER_EDIT_CODE_MESSAGES.ORDER_EDIT_NATIVE_COUPON_REDEMPTION_UNAVAILABLE,
      );

      const limitError = new OrderEditCodeInputError("ORDER_EDIT_CODES_LIMIT", {
        maxCodes: 5,
      });
      expect(resolveOrderEditCodeErrorMessage(limitError)).toBe(
        "You can add up to 5 codes.",
      );

      const parsedConfig = customerAccountPageConfigSchema.parse({
        themeId: "123456",
        customerId: "789012",
        proxyPath: "/apps/order-tools",
        codeMessages: {
          ORDER_EDIT_NATIVE_COUPON_REDEMPTION_UNAVAILABLE:
            "Single-use promo codes can only be entered during checkout.",
          ORDER_EDIT_CODES_LIMIT: "Maximum {maxCodes} promo codes allowed per order.",
        },
      });

      expect(
        resolveOrderEditCodeErrorMessage(cappedCouponError, parsedConfig.codeMessages),
      ).toBe("Single-use promo codes can only be entered during checkout.");
      expect(
        resolveOrderEditCodeErrorMessage(limitError, parsedConfig.codeMessages),
      ).toBe("Maximum 5 promo codes allowed per order.");
    });

    it("rejects HTML markup or control characters in theme codeMessages overrides", () => {
      expect(
        customerAccountPageConfigSchema.safeParse({
          themeId: "123456",
          customerId: "789012",
          proxyPath: "/apps/order-tools",
          codeMessages: {
            ORDER_EDIT_CODE_ALREADY_APPLIED: "<script>alert(1)</script>",
          },
        }).success,
      ).toBe(false);

      expect(
        customerAccountPageConfigSchema.safeParse({
          themeId: "123456",
          customerId: "789012",
          proxyPath: "/apps/order-tools",
          codeMessages: {
            ORDER_EDIT_CODE_ALREADY_APPLIED: "Line 1\u0000Line 2",
          },
        }).success,
      ).toBe(false);
    });
  });

  describe("CUST-07: Shared feature boundary isolation", () => {
    it("keeps customer-account free of staff OrderEdits page imports and ReturnCases free of Dropship page imports", () => {
      const customerAccountDir = path.resolve(
        import.meta.dirname,
        "../../../customer-account",
      );
      for (const entry of fs.readdirSync(customerAccountDir, { withFileTypes: true })) {
        if (!entry.isFile() || !/\.(ts|tsx)$/.test(entry.name)) continue;
        const specifiers = collectStaticImportSpecifiers(
          path.join(customerAccountDir, entry.name),
        );
        expect(
          specifiers.filter((s) => s.includes("pages/OrderEdits")),
          `${entry.name} must not import from pages/OrderEdits`,
        ).toEqual([]);
      }

      const returnCasesPath = path.resolve(
        import.meta.dirname,
        "../../../pages/ReturnCases.tsx",
      );
      const returnCasesImports = collectStaticImportSpecifiers(returnCasesPath);
      expect(
        returnCasesImports.filter((s) => s.includes("pages/Dropship")),
      ).toEqual([]);

      // Compatibility re-exports remain identical references
      expect(PageReexportedOrderDraft).toBe(SharedOrderDraft);
      expect(PageReexportedOperationView).toBe(SharedOperationView);
    });
  });
});
