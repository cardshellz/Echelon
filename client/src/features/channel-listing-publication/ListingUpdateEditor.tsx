import { useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { Loader2 } from "lucide-react";
import {
  hasListingUpdateChanges,
  listingUpdateContextSchema,
  listingUpdateViewSchema,
  type ListingUpdateContext,
  type ListingUpdateView,
} from "@shared/types/channel-listing-update";
import { listingTaxonomySchema } from "@shared/types/channel-listing-publication";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { publicationRequest } from "./api";
import { errorMessage, money } from "./model";
import { SchemaFields } from "./SchemaFields";
import { ListingProductTypePicker } from "./ListingProductTypePicker";
import {
  initialListingUpdateFields,
  listingUpdateChanges,
  listingUpdateContentResubmission,
  updateFieldLabel,
} from "./listing-update-model";

export function ListingUpdateEditor({
  channelId,
  sku,
  onClose,
  onSubmitted,
}: {
  channelId: number;
  sku: string;
  onClose(): void;
  onSubmitted(update: ListingUpdateView): void;
}) {
  const base = `/api/channels/${channelId}/listing-updates`;
  const context = useQuery({
    queryKey: [base, "item", sku],
    queryFn: () =>
      publicationRequest(
        "GET",
        `${base}/item?${new URLSearchParams({ sku })}`,
        listingUpdateContextSchema,
      ),
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnMount: "always",
    retry: false,
  });
  if (context.data && !context.isFetching)
    return (
      <UpdateForm
        key={context.data.sourceHash}
        channelId={channelId}
        base={base}
        context={context.data}
        onClose={onClose}
        onSubmitted={onSubmitted}
      />
    );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Walmart listing</DialogTitle>
          <DialogDescription>{sku}</DialogDescription>
        </DialogHeader>
        {context.error ? (
          <>
            <p role="alert">{errorMessage(context.error)}</p>
            <Button onClick={() => void context.refetch()}>
              Retry loading listing
            </Button>
          </>
        ) : (
          <p role="status" className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading Walmart listing…
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function UpdateForm({
  base,
  channelId,
  context,
  onClose,
  onSubmitted,
}: {
  base: string;
  channelId: number;
  context: ListingUpdateContext;
  onClose(): void;
  onSubmitted(update: ListingUpdateView): void;
}) {
  const prefix = useId();
  const original = useRef(initialListingUpdateFields(context));
  const [fields, setFields] = useState(original.current);
  const [review, setReview] = useState<ListingUpdateView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const commandKey = useRef<string | null>(null);
  const pending = context.updates.find((update) =>
    ["queued", "sending", "processing", "uncertain"].includes(update.state),
  );
  const taxonomy = useQuery({
    queryKey: [`/api/channels/${channelId}/listing-publications`, "taxonomy"],
    queryFn: () =>
      publicationRequest(
        "GET",
        `/api/channels/${channelId}/listing-publications/taxonomy`,
        listingTaxonomySchema,
      ),
  });
  const requirements = useQuery({
    queryKey: [base, "requirements", fields.productType],
    enabled: Boolean(fields.productType),
    queryFn: () =>
      publicationRequest(
        "GET",
        `${base}/requirements?${new URLSearchParams({ productType: fields.productType })}`,
        z.record(z.unknown()),
      ),
    retry: false,
  });
  async function reviewChanges() {
    setBusy(true);
    setError("");
    try {
      // The suggested type is already prefilled from the previous submission.
      // Compare with Walmart's readback, not that suggestion, so the primary
      // action cannot reduce a category correction to a price-only feed.
      const changes = context.current.productType !== fields.productType
        ? listingUpdateContentResubmission(
            original.current,
            fields,
            requirements.data ?? {},
          )
        : listingUpdateChanges(original.current, fields);
      if (!hasListingUpdateChanges(changes)) {
        throw new Error(
          "No fields changed. Edit at least one field before reviewing.",
        );
      }
      const result = await publicationRequest(
        "POST",
        `${base}/review`,
        listingUpdateViewSchema,
        {
          sku: context.current.sku,
          sourceHash: context.sourceHash,
          productType: fields.productType,
          changes,
        },
      );
      commandKey.current = crypto.randomUUID();
      setReview(result);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  async function sendChanges() {
    if (!review || !commandKey.current) return;
    setBusy(true);
    setError("");
    try {
      onSubmitted(
        await publicationRequest(
          "POST",
          `${base}/${review.id}/submit`,
          listingUpdateViewSchema,
          { reviewHash: review.reviewHash, commandKey: commandKey.current },
        ),
      );
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  const changes = review?.changes;
  const textField = (
    key: "title" | "description" | "brand" | "images",
    label: string,
    rows?: number,
  ) => (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={`${prefix}-${key}`}>{label}</Label>
      {rows ? (
        <Textarea
          id={`${prefix}-${key}`}
          rows={rows}
          value={fields[key]}
          onChange={(event) =>
            setFields((previous) => ({
              ...previous,
              [key]: event.target.value,
            }))
          }
        />
      ) : (
        <Input
          id={`${prefix}-${key}`}
          value={fields[key]}
          onChange={(event) =>
            setFields((previous) => ({
              ...previous,
              [key]: event.target.value,
            }))
          }
        />
      )}
    </div>
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="flex max-h-[94dvh] max-w-4xl flex-col gap-0 overflow-clip p-0">
        <DialogHeader className="shrink-0 border-b p-4 pr-12 text-left sm:p-5 sm:pr-12">
          <DialogTitle>
            {review ? "Review listing changes" : "Edit Walmart listing"}
          </DialogTitle>
          <DialogDescription className="break-words">
            {context.current.title}
            <span className="mt-1 block font-mono text-xs">
              {context.current.sku}
            </span>
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-5 overflow-y-auto p-4 sm:p-5">
          {pending && (
            <p role="status" className="rounded-md border p-3 text-sm">
              {pending.state === "uncertain"
                ? pending.message
                : "An update is already in progress for this listing. Check its status in Activity before sending another."}
            </p>
          )}
          {review ? (
            <>
              <p className="text-sm text-muted-foreground">
                These changes update the existing Walmart listing. Stock
                quantities stay unchanged.
              </p>
              <dl className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-4 gap-y-3 text-sm">
                <dt>Product type for these fields</dt>
                <dd className="break-words font-medium">
                  {review.productType}
                </dd>
                {changes?.priceCents !== undefined && (
                  <>
                    <dt>Price</dt>
                    <dd>{money(changes.priceCents)}</dd>
                  </>
                )}
                {(["title", "description", "brand", "images"] as const).map(
                  (key) =>
                    changes?.[key] === undefined ? null : (
                      <div key={key} className="contents">
                        <dt className="capitalize">{key}</dt>
                        <dd className="max-h-40 overflow-auto whitespace-pre-wrap break-words">
                          {Array.isArray(changes[key])
                            ? changes[key].join("\n")
                            : changes[key]}
                        </dd>
                      </div>
                    ),
                )}
                {Object.entries(changes?.attributes ?? {}).flatMap(
                  ([section, values]) =>
                    Object.entries(values ?? {}).map(([key, value]) => (
                      <div key={`${section}.${key}`} className="contents">
                        <dt>
                          {updateFieldLabel(requirements.data, section, key)}
                        </dt>
                        <dd className="whitespace-pre-wrap break-words">
                          {typeof value === "object"
                            ? JSON.stringify(value, null, 2)
                            : String(value)}
                        </dd>
                      </div>
                    )),
                )}
              </dl>
              {review.issues.length > 0 && (
                <ul
                  role="alert"
                  className="list-inside list-disc space-y-2 text-sm text-destructive"
                >
                  {review.issues.map((issue, index) => (
                    <li key={index}>{issue.message}</li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <fieldset disabled={busy} className="min-w-0 space-y-6">
              <p className="text-sm text-muted-foreground">
                Edit the fields you want to change. Blank fields leave Walmart
                unchanged.
              </p>
              <section className="space-y-4">
                <h3 className="font-semibold">Price and product type</h3>
                <div className="max-w-xs space-y-1.5">
                  <Label htmlFor={`${prefix}-price`}>Walmart price (USD)</Label>
                  <Input
                    id={`${prefix}-price`}
                    inputMode="decimal"
                    value={fields.price}
                    onChange={(event) =>
                      setFields((previous) => ({
                        ...previous,
                        price: event.target.value,
                      }))
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    Current Walmart price: {money(context.current.priceCents)}
                  </p>
                </div>
                <ListingProductTypePicker
                  label="Walmart product type"
                  value={fields.productType}
                  disabled={busy}
                  taxonomy={taxonomy.data}
                  loading={taxonomy.isFetching}
                  error={
                    taxonomy.error ? errorMessage(taxonomy.error) : undefined
                  }
                  onRetry={() => void taxonomy.refetch()}
                  onSelect={(productType) =>
                    setFields((previous) => ({
                      ...previous,
                      productType,
                      attributes: {
                        Orderable: previous.attributes.Orderable ?? {},
                        Visible: {},
                      },
                    }))
                  }
                />
                {context.current.productType !== fields.productType && (
                  <div className="space-y-3 rounded-md border p-3 text-sm">
                    <p>
                      Walmart currently reports:{" "}
                      <strong>{context.current.productType || "Not returned"}</strong>.
                    </p>
                    <p>
                      Review changes will include the filled title, description,
                      brand, images and supported product details using the
                      selected type. You can review every field before sending.
                    </p>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  {context.current.identifier.type}:{" "}
                  {context.current.identifier.value} · The SKU and barcode stay
                  the same.
                </p>
              </section>
              <section className="space-y-4 border-t pt-5">
                <h3 className="font-semibold">Content</h3>
                <p className="text-xs text-muted-foreground">
                  Title and price come from Walmart. Other filled fields show
                  the last values submitted through Echelon.
                </p>
                {textField("title", "Walmart title")}
                {textField("description", "Description", 4)}
                {textField("brand", "Brand")}
                {textField("images", "Image URLs — one per line", 4)}
              </section>
              <section className="space-y-4 border-t pt-5">
                <h3 className="font-semibold">Shipping and product details</h3>
                {requirements.isFetching && (
                  <p role="status">Loading editable fields…</p>
                )}
                {requirements.error && (
                  <>
                    <p role="alert" className="text-sm text-destructive">
                      {errorMessage(requirements.error)}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void requirements.refetch()}
                    >
                      Retry editable fields
                    </Button>
                  </>
                )}
                {!fields.productType && (
                  <p className="text-sm text-muted-foreground">
                    Choose a product type to load shipping and product fields.
                  </p>
                )}
                {requirements.data && (
                  <SchemaFields
                    mode="patch"
                    schema={requirements.data}
                    value={fields.attributes}
                    onChange={(attributes) =>
                      setFields((previous) => ({ ...previous, attributes }))
                    }
                  />
                )}
              </section>
            </fieldset>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter className="shrink-0 border-t bg-background p-4 sm:p-5">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => (review ? setReview(null) : onClose())}
          >
            {review ? "Back to edit" : "Cancel"}
          </Button>
          <Button
            disabled={
              busy ||
              Boolean(pending) ||
              !fields.productType ||
              Boolean(review?.issues.length) ||
              (!review && (requirements.isFetching || !requirements.data))
            }
            onClick={() => void (review ? sendChanges() : reviewChanges())}
          >
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {busy
              ? "Working…"
              : review
                ? "Send changes to Walmart"
                : "Review changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
