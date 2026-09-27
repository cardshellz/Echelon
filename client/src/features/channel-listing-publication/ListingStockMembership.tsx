import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  applyPublicationMembershipSchema,
  inspectPublicationMembershipSchema,
  publicationMembershipInspectionSchema,
  publicationMembershipReceiptSchema,
  publicationMembershipReviewSchema,
  reviewPublicationMembershipSchema,
  type PublicationMembershipBlocker,
  type PublicationMembershipReceipt,
  type PublicationMembershipReview,
} from "@shared/types/inventory-publication-membership";
import type { ListingOperationItem } from "@shared/types/channel-listing-publication";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { publicationRequest } from "./api";
import { errorMessage } from "./model";

const BASE = "/api/inventory-planning/admin/publication-membership";
interface Props {
  channelId: number;
  connectionId: number;
  items: ListingOperationItem[];
}

function Blockers({ blockers }: { blockers: PublicationMembershipBlocker[] }) {
  return blockers.length > 0 ? (
    <div className="space-y-2 rounded-md border p-3">
      <ul className="list-disc space-y-1 pl-5 text-sm text-destructive">
        {blockers.map((blocker, index) => (
          <li key={`${blocker.code}-${blocker.productVariantId}-${index}`}>
            {blocker.message}
          </li>
        ))}
      </ul>
      <a
        className="inline-block text-sm underline"
        href="/channels/inventory"
        target="_blank"
        rel="noreferrer"
      >
        Open Channel Inventory setup
      </a>
    </div>
  ) : null;
}

/** Membership delegates to the canonical inventory review/apply API; it never pushes quantities. */
export function ListingStockMembership({
  channelId,
  connectionId,
  items,
}: Props) {
  const { hasPermission } = useAuth();
  const canView = hasPermission("inventory_planning", "view");
  const canActivate =
    canView && hasPermission("inventory_planning", "activate");
  const [open, setOpen] = useState(false);
  const [targetId, setTargetId] = useState<number | null>(null);
  const [included, setIncluded] = useState<ReadonlySet<number>>(new Set());
  const [review, setReview] = useState<PublicationMembershipReview | null>(
    null,
  );
  const [receipt, setReceipt] = useState<PublicationMembershipReceipt | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const commandKey = useRef<string | null>(null);
  const verified = items.filter((item) => item.state === "verified");
  const ids = [...new Set(verified.map((item) => item.variantId))].sort(
    (a, b) => a - b,
  );
  const inspection = useQuery({
    queryKey: [BASE, channelId, connectionId, ids.join(",")],
    enabled: open && canView && ids.length > 0,
    queryFn: () =>
      publicationRequest(
        "POST",
        `${BASE}/inspect`,
        publicationMembershipInspectionSchema,
        inspectPublicationMembershipSchema.parse({
          channelId,
          channelConnectionId: connectionId,
          productVariantIds: ids,
        }),
      ),
  });
  const target = inspection.data?.targets.find(
    (candidate) => candidate.publicationTargetId === targetId,
  );
  const targetMembership = target
    ? `${target.publicationTargetId}:${target.revision}:${target.variants.map((item) => `${item.productVariantId}:${item.included}`).join(",")}`
    : "";
  useEffect(() => {
    if (inspection.data?.targets.length === 1)
      setTargetId(inspection.data.targets[0].publicationTargetId);
  }, [inspection.data]);
  useEffect(() => {
    setIncluded(
      new Set(
        target?.variants
          .filter(
            (item) => item.included && ids.includes(item.productVariantId),
          )
          .map((item) => item.productVariantId) ?? [],
      ),
    );
    setReview(null);
    commandKey.current = null;
  }, [targetMembership]);
  const variants =
    target?.variants.filter((item) => ids.includes(item.productVariantId)) ??
    [];
  const changes = variants
    .filter((item) => item.included !== included.has(item.productVariantId))
    .map((item) => ({
      productVariantId: item.productVariantId,
      included: included.has(item.productVariantId),
    }));

  async function inspectAgain() {
    setReview(null);
    commandKey.current = null;
    setError("");
    await inspection.refetch();
  }
  async function createReview() {
    if (!target || changes.length === 0) return;
    setBusy(true);
    setError("");
    setReceipt(null);
    try {
      const input = reviewPublicationMembershipSchema.parse({
        publicationTargetId: target.publicationTargetId,
        expectedTargetRevision: target.revision,
        changes,
      });
      const next = await publicationRequest(
        "POST",
        `${BASE}/review`,
        publicationMembershipReviewSchema,
        input,
      );
      setReview(next);
      commandKey.current = crypto.randomUUID();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    if (!review || !review.ready || !commandKey.current || !canActivate) return;
    setBusy(true);
    setError("");
    try {
      const input = applyPublicationMembershipSchema.parse({
        publicationTargetId: review.publicationTargetId,
        expectedTargetRevision: review.targetRevision,
        changes: review.changes.map((change) => ({
          productVariantId: change.productVariantId,
          included: change.after,
        })),
        expectedReviewHash: review.reviewHash,
        idempotencyKey: commandKey.current,
      });
      const result = await publicationRequest(
        "POST",
        `${BASE}/apply`,
        publicationMembershipReceiptSchema,
        input,
      );
      setReceipt(result);
      setReview(null);
      commandKey.current = null;
      await inspection.refetch();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  if (verified.length === 0) return null;
  if (!canView)
    return (
      <p className="text-xs text-muted-foreground">
        An inventory planning operator can review stock publishing for these
        verified items.
      </p>
    );
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Review stock publishing
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Walmart stock publishing</DialogTitle>
            <DialogDescription>
              Select only the verified items from this submission that the
              inventory policy may publish. This does not change the policy or
              activate an inventory destination.
            </DialogDescription>
          </DialogHeader>
          {inspection.isFetching && (
            <p role="status" className="text-sm">
              Inspecting inventory readiness…
            </p>
          )}
          {inspection.error && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(inspection.error)}
            </p>
          )}
          {inspection.data && (
            <>
              <Blockers blockers={inspection.data.blockers} />
              {inspection.data.targets.length === 0 ? (
                <p className="text-sm">
                  No matching inventory destination exists.{" "}
                  <a
                    className="underline"
                    href="/channels/inventory"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Set up the Walmart destination, SKU mappings, and source in
                    Channel Inventory.
                  </a>
                </p>
              ) : (
                <div className="space-y-1.5">
                  <Label htmlFor="publication-stock-target">
                    Inventory destination
                  </Label>
                  <select
                    id="publication-stock-target"
                    disabled={busy}
                    className="min-h-10 w-full rounded-md border bg-background px-3 text-sm"
                    value={targetId ?? ""}
                    onChange={(event) => {
                      setTargetId(
                        event.target.value ? Number(event.target.value) : null,
                      );
                      setReceipt(null);
                    }}
                  >
                    <option value="">Choose a destination</option>
                    {inspection.data.targets.map((candidate) => {
                      const skus = candidate.variants
                        .map(
                          (variant) =>
                            verified.find(
                              (item) =>
                                item.variantId === variant.productVariantId,
                            )?.sku,
                        )
                        .filter(Boolean);
                      return (
                        <option
                          key={candidate.publicationTargetId}
                          value={candidate.publicationTargetId}
                        >
                          {skus.slice(0, 2).join(", ")}
                          {skus.length > 2 ? "…" : ""} · fulfillment{" "}
                          {candidate.externalScopeId}
                        </option>
                      );
                    })}
                  </select>
                </div>
              )}
              {target && (
                <>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="secondary">
                      {target.state === "live"
                        ? "Destination active"
                        : target.state === "preview"
                          ? "Destination in preview"
                          : "Destination disabled"}
                    </Badge>
                    <Badge variant="secondary">
                      {target.mode === "explicit"
                        ? "Explicit SKU selection"
                        : "Whole-product scope"}
                    </Badge>
                  </div>
                  <div className="divide-y">
                    {variants.map((variant) => (
                      <label
                        key={variant.productVariantId}
                        className="flex items-start gap-3 py-3"
                      >
                        <input
                          type="checkbox"
                          className="mt-1 h-4 w-4"
                          aria-label={`Publish stock for ${verified.find((item) => item.variantId === variant.productVariantId)?.sku ?? variant.productVariantId}`}
                          checked={included.has(variant.productVariantId)}
                          disabled={busy}
                          onChange={(event) => {
                            setIncluded((previous) => {
                              const next = new Set(previous);
                              if (event.target.checked)
                                next.add(variant.productVariantId);
                              else next.delete(variant.productVariantId);
                              return next;
                            });
                            setReview(null);
                            setReceipt(null);
                            commandKey.current = null;
                          }}
                        />
                        <span className="min-w-0">
                          <span className="block break-all font-mono text-sm">
                            {
                              verified.find(
                                (item) =>
                                  item.variantId === variant.productVariantId,
                              )?.sku
                            }
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {variant.mappingReady
                              ? "Exact inventory mapping verified"
                              : "Inventory mapping needs setup"}{" "}
                            ·{" "}
                            {variant.included
                              ? "Currently included"
                              : "Currently excluded"}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Removing an included item requires the inventory hold and
                    verified zero-stock checks. All other items retain their
                    existing selection.
                  </p>
                </>
              )}
            </>
          )}
          {review && (
            <section className="space-y-3 rounded-md border p-3">
              <h3 className="font-medium">
                Review {review.changes.length} stock selection changes
              </h3>
              <Blockers blockers={review.blockers} />
              <ul className="space-y-2 text-sm">
                {review.changes.map((change) => (
                  <li key={change.productVariantId}>
                    <strong>
                      {verified.find(
                        (item) => item.variantId === change.productVariantId,
                      )?.sku ?? `Variant ${change.productVariantId}`}
                    </strong>
                    : {change.before ? "Included" : "Excluded"} →{" "}
                    {change.after ? "Included" : "Excluded"}
                    {review.quantities.find(
                      (quantity) =>
                        quantity.productVariantId === change.productVariantId,
                    )
                      ? ` · policy quantity ${review.quantities.find((quantity) => quantity.productVariantId === change.productVariantId)!.desiredQuantity}`
                      : ""}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                These are policy quantities to queue. They are not confirmed
                Walmart quantities.
              </p>
              {!canActivate && (
                <p className="text-sm text-muted-foreground">
                  Inventory activation permission is required to apply this
                  review.
                </p>
              )}
            </section>
          )}
          {receipt && (
            <p role="status" className="rounded-md border p-3 text-sm">
              Stock selection saved.{" "}
              {receipt.publicationRows > 0
                ? `${receipt.publicationRows} inventory updates queued; Walmart quantities are not yet confirmed.`
                : "No new inventory updates were queued."}
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy || inspection.isFetching}
              onClick={() => void inspectAgain()}
            >
              Refresh readiness
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              Close
            </Button>
            {review ? (
              <Button
                disabled={busy || !review.ready || !canActivate}
                onClick={() => void apply()}
              >
                {busy ? "Applying…" : "Apply stock selection"}
              </Button>
            ) : (
              <Button
                disabled={busy || inspection.isFetching || changes.length === 0}
                onClick={() => void createReview()}
              >
                {busy ? "Reviewing…" : "Review stock changes"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
