import React, { useEffect, useRef, useState } from "react";
import { DollarSign, Loader2, RefreshCw, WalletCards } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  ReturnCaseAdminApiError,
  createReturnCaseIdempotencyKey,
  getCustomerRefundPreview,
  getVendorSettlementPreview,
  issueReturnCustomerRefund,
  settleReturnVendorAccount,
  type CustomerRefundPreview,
  type DropshipReturnFaultCategory,
  type IssueCustomerRefundResult,
  type ReturnCaseAction,
  type SettleVendorAccountResult,
  type VendorSettlementPreview,
} from "./return-case-admin-api";

const MAX_NOTES_LENGTH = 2_000;

interface FinancialDialogBaseProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  returnCaseId: number;
  action: ReturnCaseAction | null;
  onRefreshRequested(): Promise<void>;
}

interface IssueCustomerRefundDialogProps extends FinancialDialogBaseProps {
  onCompleted(result: IssueCustomerRefundResult): void;
}

export function IssueCustomerRefundDialog({
  open,
  onOpenChange,
  returnCaseId,
  action,
  onRefreshRequested,
  onCompleted,
}: IssueCustomerRefundDialogProps) {
  const wasOpen = useRef(false);
  const [preview, setPreview] = useState<CustomerRefundPreview | null>(null);
  const [notifyCustomer, setNotifyCustomer] = useState(true);
  const [notes, setNotes] = useState("");
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [commandIdentity, setCommandIdentity] = useState<CommandIdentity | null>(null);

  useEffect(() => {
    if (!open) {
      wasOpen.current = false;
      return;
    }
    if (wasOpen.current) return;
    wasOpen.current = true;
    if (preview === null) void loadPreview();
  // loadPreview is intentionally invoked only on an open transition. Retry uses the explicit button.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open && action?.state !== "available") onOpenChange(false);
  }, [action?.state, onOpenChange, open]);

  const loadPreview = async () => {
    setLoadingPreview(true);
    setError(null);
    try {
      const nextPreview = await getCustomerRefundPreview(returnCaseId);
      setPreview(nextPreview);
      if (preview?.quoteHash !== nextPreview.quoteHash) setCommandIdentity(null);
    } catch (nextError) {
      setError(nextError);
    } finally {
      setLoadingPreview(false);
    }
  };

  const submit = async () => {
    if (preview === null || pending || action?.state !== "available") return;
    const normalizedNotes = normalizeNotes(notes);
    const signature = JSON.stringify({
      quoteHash: preview.quoteHash,
      notifyCustomer,
      notes: normalizedNotes,
    });
    const identity = commandIdentity?.signature === signature
      ? commandIdentity
      : {
          signature,
          idempotencyKey: createReturnCaseIdempotencyKey("issue_customer_refund"),
        };
    if (identity !== commandIdentity) setCommandIdentity(identity);

    setPending(true);
    setError(null);
    try {
      const result = await issueReturnCustomerRefund(returnCaseId, {
        idempotencyKey: identity.idempotencyKey,
        quoteHash: preview.quoteHash,
        notifyCustomer,
        notes: normalizedNotes,
      });
      assertRefundResultMatchesPreview(result, preview);
      onCompleted(result);
    } catch (nextError) {
      setError(nextError);
      if (isConflict(nextError)) {
        await refreshAfterConflict(onRefreshRequested);
        setPreview(null);
        setCommandIdentity(null);
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !pending && onOpenChange(nextOpen)}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Issue Shopify customer refund</DialogTitle>
          <DialogDescription>
            Refund the customer for this approved Card Shellz return through the connected Shopify store.
          </DialogDescription>
        </DialogHeader>

        <Alert>
          <DollarSign />
          <AlertTitle>This creates a real customer refund</AlertTitle>
          <AlertDescription>
            Shopify receives the refund request. Inventory is not restocked here; the physical inventory treatment remains a separate operation.
          </AlertDescription>
        </Alert>

        {loadingPreview && <LoadingState label="Loading the current Shopify refund amount..." />}
        {!loadingPreview && preview && <CustomerRefundReview preview={preview} />}
        {!loadingPreview && !preview && (
          <Button type="button" variant="outline" onClick={() => void loadPreview()}>
            <RefreshCw />
            Load refund preview
          </Button>
        )}

        <label className="flex items-start gap-3 border p-3 text-sm">
          <Checkbox
            checked={notifyCustomer}
            disabled={pending}
            onCheckedChange={(checked) => {
              setNotifyCustomer(checked === true);
              setCommandIdentity(null);
            }}
          />
          <span>
            <span className="block font-medium">Send Shopify refund notification</span>
            <span className="text-muted-foreground">Shopify will notify the customer about the refund.</span>
          </span>
        </label>

        <label className="block space-y-2 text-sm font-medium">
          Refund notes (optional)
          <Textarea
            value={notes}
            maxLength={MAX_NOTES_LENGTH}
            disabled={pending}
            placeholder="Internal reason or refund evidence"
            onChange={(event) => {
              setNotes(event.target.value);
              setCommandIdentity(null);
            }}
          />
        </label>

        {error !== null && <FinancialOperationError error={error} />}

        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={pending || loadingPreview || preview === null || action?.state !== "available"}
            onClick={() => void submit()}
          >
            {pending && <Loader2 className="animate-spin" />}
            Issue {preview ? formatMoney(preview.quote.amountCents, preview.quote.currency) : "customer refund"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CustomerRefundReview({ preview }: { preview: CustomerRefundPreview }) {
  return (
    <div className="space-y-3 border p-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="text-xs text-muted-foreground">Shopify order</div>
          <div className="font-medium">{preview.externalOrderId}</div>
        </div>
        <div className="text-right">
          <div className="text-xs text-muted-foreground">Refund total</div>
          <div className="text-lg font-semibold">{formatMoney(preview.quote.amountCents, preview.quote.currency)}</div>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px]">
          <thead className="border-b text-left text-xs text-muted-foreground">
            <tr>
              <th className="py-2 pr-3 font-medium">Returned line</th>
              <th className="py-2 pr-3 text-right font-medium">Qty</th>
              <th className="py-2 pr-3 text-right font-medium">Subtotal</th>
              <th className="py-2 text-right font-medium">Tax</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {preview.quote.lines.map((line) => (
              <tr key={line.returnCaseItemId}>
                <td className="py-2 pr-3 font-mono text-xs">{line.externalLineItemId}</td>
                <td className="py-2 pr-3 text-right">{line.quantity}</td>
                <td className="py-2 pr-3 text-right">{formatMoney(line.subtotalCents, preview.quote.currency)}</td>
                <td className="py-2 text-right">{formatMoney(line.taxCents, preview.quote.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Maximum currently refundable: {formatMoney(preview.quote.maximumRefundableCents, preview.quote.currency)}. The quote is revalidated before submission.
      </p>
    </div>
  );
}

interface SettleVendorAccountDialogProps extends FinancialDialogBaseProps {
  onCompleted(result: SettleVendorAccountResult): void;
}

export function SettleVendorAccountDialog({
  open,
  onOpenChange,
  returnCaseId,
  action,
  onRefreshRequested,
  onCompleted,
}: SettleVendorAccountDialogProps) {
  const [faultCategory, setFaultCategory] = useState<DropshipReturnFaultCategory | "">("");
  const [preview, setPreview] = useState<VendorSettlementPreview | null>(null);
  const [notes, setNotes] = useState("");
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [commandIdentity, setCommandIdentity] = useState<CommandIdentity | null>(null);

  useEffect(() => {
    if (open && action?.state !== "available") onOpenChange(false);
  }, [action?.state, onOpenChange, open]);

  const loadPreview = async () => {
    if (faultCategory === "") return;
    setLoadingPreview(true);
    setError(null);
    try {
      const nextPreview = await getVendorSettlementPreview(returnCaseId, faultCategory);
      setPreview(nextPreview);
      setCommandIdentity(null);
    } catch (nextError) {
      setError(nextError);
      setPreview(null);
    } finally {
      setLoadingPreview(false);
    }
  };

  const submit = async () => {
    if (preview === null || faultCategory === "" || pending || action?.state !== "available") return;
    const normalizedNotes = normalizeNotes(notes);
    const signature = JSON.stringify({
      quoteHash: preview.quoteHash,
      faultCategory,
      notes: normalizedNotes,
    });
    const identity = commandIdentity?.signature === signature
      ? commandIdentity
      : {
          signature,
          idempotencyKey: createReturnCaseIdempotencyKey("settle_vendor_account"),
        };
    if (identity !== commandIdentity) setCommandIdentity(identity);

    setPending(true);
    setError(null);
    try {
      const result = await settleReturnVendorAccount(returnCaseId, {
        idempotencyKey: identity.idempotencyKey,
        quoteHash: preview.quoteHash,
        faultCategory,
        notes: normalizedNotes,
      });
      assertSettlementResultMatchesPreview(result, preview);
      onCompleted(result);
    } catch (nextError) {
      setError(nextError);
      if (isConflict(nextError)) {
        await refreshAfterConflict(onRefreshRequested);
        setPreview(null);
        setCommandIdentity(null);
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !pending && onOpenChange(nextOpen)}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Settle vendor account</DialogTitle>
          <DialogDescription>
            Calculate and post this dropship return to the vendor's internal Echelon wallet.
          </DialogDescription>
        </DialogHeader>

        <Alert>
          <WalletCards />
          <AlertTitle>This does not refund the marketplace buyer</AlertTitle>
          <AlertDescription>
            Echelon records only the vendor-facing credit and fees. The marketplace or store owns its buyer relationship and refund.
          </AlertDescription>
        </Alert>

        <label className="block space-y-2 text-sm font-medium">
          Return responsibility
          <Select
            value={faultCategory}
            disabled={pending}
            onValueChange={(value) => {
              setFaultCategory(value as DropshipReturnFaultCategory);
              setPreview(null);
              setCommandIdentity(null);
              setError(null);
            }}
          >
            <SelectTrigger><SelectValue placeholder="Select who is responsible" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="card_shellz">Card Shellz</SelectItem>
              <SelectItem value="vendor">Vendor</SelectItem>
              <SelectItem value="customer">Customer</SelectItem>
              <SelectItem value="marketplace">Marketplace / store</SelectItem>
              <SelectItem value="carrier">Carrier</SelectItem>
            </SelectContent>
          </Select>
        </label>

        {preview === null && (
          <Button
            type="button"
            variant="outline"
            disabled={faultCategory === "" || loadingPreview || pending}
            onClick={() => void loadPreview()}
          >
            {loadingPreview ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Calculate settlement
          </Button>
        )}
        {preview && <VendorSettlementReview preview={preview} />}

        <label className="block space-y-2 text-sm font-medium">
          Settlement notes (optional)
          <Textarea
            value={notes}
            maxLength={MAX_NOTES_LENGTH}
            disabled={pending}
            placeholder="Responsibility or fee evidence"
            onChange={(event) => {
              setNotes(event.target.value);
              setCommandIdentity(null);
            }}
          />
        </label>

        {error !== null && <FinancialOperationError error={error} />}

        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={pending || preview === null || faultCategory === "" || action?.state !== "available"}
            onClick={() => void submit()}
          >
            {pending && <Loader2 className="animate-spin" />}
            Post vendor settlement
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function VendorSettlementReview({ preview }: { preview: VendorSettlementPreview }) {
  const money = preview.quote.settlement;
  const rows = [
    ["Product credit", money.productCreditCents],
    ["Original shipping credit", money.originalShippingCreditCents],
    ["Restocking fee", -money.restockingFeeCents],
    ["Processing fee", -money.processingFeeCents],
    ["Return shipping fee", -money.returnShippingFeeCents],
  ] as const;
  return (
    <div className="space-y-3 border p-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="text-xs text-muted-foreground">Vendor</div>
          <div className="font-medium">Vendor #{preview.vendorId}</div>
        </div>
        <div className="text-right">
          <div className="text-xs text-muted-foreground">Net wallet settlement</div>
          <div className="text-lg font-semibold">{formatMoney(money.netSettlementCents, preview.quote.currency)}</div>
        </div>
      </div>
      <dl className="divide-y border-y">
        {rows.map(([label, cents]) => (
          <div key={label} className="flex justify-between gap-4 py-2">
            <dt>{label}</dt>
            <dd className="font-mono">{formatMoney(cents, preview.quote.currency)}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">
        Gross credit {formatMoney(money.grossCreditCents, preview.quote.currency)} less fees {formatMoney(money.totalFeeCents, preview.quote.currency)}. The quote is revalidated before posting.
      </p>
    </div>
  );
}

interface CommandIdentity {
  signature: string;
  idempotencyKey: string;
}

function normalizeNotes(notes: string): string | null {
  const normalized = notes.trim();
  return normalized === "" ? null : normalized;
}

function isConflict(error: unknown): error is ReturnCaseAdminApiError {
  return error instanceof ReturnCaseAdminApiError && error.status === 409;
}

async function refreshAfterConflict(refresh: () => Promise<void>): Promise<void> {
  try {
    await refresh();
  } catch {
    // Preserve the operation error; the operator can explicitly retry the preview.
  }
}

function assertRefundResultMatchesPreview(
  result: IssueCustomerRefundResult,
  preview: CustomerRefundPreview,
): void {
  if (result.amountCents !== preview.quote.amountCents || result.currency !== preview.quote.currency) {
    throw responseMismatch("Shopify refund result does not match the reviewed quote.");
  }
}

function assertSettlementResultMatchesPreview(
  result: SettleVendorAccountResult,
  preview: VendorSettlementPreview,
): void {
  const reviewed = preview.quote.settlement;
  if (result.currency !== preview.quote.currency
    || result.grossCreditCents !== reviewed.grossCreditCents
    || result.totalFeeCents !== reviewed.totalFeeCents
    || result.netSettlementCents !== reviewed.netSettlementCents) {
    throw responseMismatch("Vendor settlement result does not match the reviewed quote.");
  }
}

function responseMismatch(message: string): ReturnCaseAdminApiError {
  return new ReturnCaseAdminApiError({
    code: "RETURN_CASE_RESPONSE_INVALID",
    message,
    status: 502,
  });
}

function FinancialOperationError({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : "Financial operation could not be completed.";
  const code = error instanceof ReturnCaseAdminApiError ? error.code : null;
  return (
    <Alert variant="destructive">
      <AlertTitle>Financial operation could not be completed</AlertTitle>
      <AlertDescription>
        <p>{message}</p>
        {code && <p className="mt-1 font-mono text-xs">{code}</p>}
      </AlertDescription>
    </Alert>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 border p-3 text-sm text-muted-foreground">
      <Loader2 className="animate-spin" />
      {label}
    </div>
  );
}

export function formatMoney(cents: number, currency: string): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  const whole = Math.floor(absolute / 100);
  const fractional = String(absolute % 100).padStart(2, "0");
  return `${sign}${currency} ${whole.toLocaleString("en-US")}.${fractional}`;
}
