import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  FileCheck2,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import {
  HistoricalShipStationContentsAttestationApiError,
  loadHistoricalShipStationContentsAttestationPreview,
  submitHistoricalShipStationContentsAttestation,
} from "@/lib/historical-shipstation-contents-attestation";
import {
  historicalContentsAttestationReadiness,
  historicalContentsComparisonRows,
  parseHistoricalContentsLabelId,
  type HistoricalContentsComparisonStatus,
} from "./historical-shipment-contents-review-model";
import type {
  HistoricalShipStationContentsAttestationPreview,
  HistoricalShipStationContentsAttestationResult,
} from "@shared/types/historical-shipstation-contents-attestation";

export default function HistoricalShipmentContentsReview() {
  const { hasPermission } = useAuth();
  const { toast } = useToast();
  const canAttest = hasPermission("inventory", "adjust");
  const [labelInput, setLabelInput] = useState("");
  const [selectedLabelId, setSelectedLabelId] = useState<string | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [receipt, setReceipt] = useState<HistoricalShipStationContentsAttestationResult | null>(
    null,
  );

  const previewQuery = useQuery({
    queryKey: ["historical-shipstation-contents-attestation-preview", selectedLabelId],
    queryFn: () => {
      if (selectedLabelId === null) throw new Error("Shipping provider label ID is required.");
      return loadHistoricalShipStationContentsAttestationPreview(selectedLabelId);
    },
    enabled: selectedLabelId !== null,
    retry: false,
  });
  const preview = previewQuery.data ?? null;
  const comparisonRows = useMemo(
    () => preview === null ? [] : historicalContentsComparisonRows(preview),
    [preview],
  );
  const readiness = useMemo(() => historicalContentsAttestationReadiness({
    canAttest,
    preview,
    reason,
    reviewConfirmed,
  }), [canAttest, preview, reason, reviewConfirmed]);

  useEffect(() => {
    setReason("");
    setReviewConfirmed(false);
    setReceipt(null);
  }, [preview?.previewEvidenceHash]);

  const attestationMutation = useMutation({
    mutationFn: async () => {
      if (preview === null || readiness.request === null) {
        throw new Error("A current reviewed preview is required.");
      }
      return submitHistoricalShipStationContentsAttestation(
        preview.shippingProviderLabelId,
        readiness.request,
      );
    },
    onSuccess: (result) => {
      setReceipt(result);
      setReviewConfirmed(false);
      toast({
        title: result.kind === "created" ? "Attestation recorded" : "Attestation already recorded",
        description: `${result.resolvedEventCount} historical label event${
          result.resolvedEventCount === 1 ? " was" : "s were"
        } linked to immutable evidence.`,
      });
    },
    onError: async (error: Error) => {
      setReviewConfirmed(false);
      if (
        error instanceof HistoricalShipStationContentsAttestationApiError
        && ["PREVIEW_EVIDENCE_MISMATCH", "CANDIDATE_CHANGED"].includes(error.code)
      ) {
        setReason("");
        const refreshResult = await previewQuery.refetch();
        if (!refreshResult.isSuccess) {
          setSelectedLabelId(null);
          toast({
            title: "Preview changed and could not be reloaded",
            description: "Nothing was recorded. Load the label again before continuing.",
            variant: "destructive",
          });
          return;
        }
        toast({
          title: "Preview changed and was reloaded",
          description: "Nothing was recorded. Review the current evidence again.",
          variant: "destructive",
        });
        return;
      }
      toast({
        title: "Attestation was not recorded",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const updateLabelInput = (value: string) => {
    setLabelInput(value);
    setInputError(null);
    if (selectedLabelId !== null && value.trim() !== selectedLabelId) {
      setSelectedLabelId(null);
      setReason("");
      setReviewConfirmed(false);
      setReceipt(null);
    }
  };

  const loadPreview = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = parseHistoricalContentsLabelId(labelInput);
    if (!parsed.valid) {
      setInputError(parsed.message);
      setSelectedLabelId(null);
      setReason("");
      setReviewConfirmed(false);
      setReceipt(null);
      return;
    }
    setInputError(null);
    setReason("");
    setReviewConfirmed(false);
    setReceipt(null);
    if (parsed.value === selectedLabelId) {
      void previewQuery.refetch();
      return;
    }
    setSelectedLabelId(parsed.value);
  };

  const resetReview = () => {
    setLabelInput("");
    setSelectedLabelId(null);
    setInputError(null);
    setReason("");
    setReviewConfirmed(false);
    setReceipt(null);
  };

  return (
    <div className="container mx-auto max-w-6xl space-y-6 py-6">
      <div>
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-7 w-7 text-primary" aria-hidden="true" />
          <h1 className="text-3xl font-bold tracking-tight">Historical shipment contents review</h1>
        </div>
        <p className="mt-2 max-w-4xl text-muted-foreground">
          Compare the current WMS package lineage with ShipStation shipment contents before
          recording immutable evidence for a historical label. This does not change package items
          or inventory, and it does not grant package-allocation authority.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Load one shipping label</CardTitle>
          <CardDescription>
            Use the internal shipping provider label ID. Only unresolved historical candidates can
            produce a preview.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={loadPreview}>
            <div className="flex-1 space-y-2">
              <Label htmlFor="shipping-provider-label-id">Shipping provider label ID</Label>
              <Input
                id="shipping-provider-label-id"
                value={labelInput}
                onChange={(event) => updateLabelInput(event.target.value)}
                inputMode="numeric"
                autoComplete="off"
                placeholder="Example: 5530"
                aria-invalid={inputError !== null}
                aria-describedby={inputError ? "shipping-provider-label-id-error" : undefined}
              />
              {inputError && (
                <p id="shipping-provider-label-id-error" className="text-sm text-destructive">
                  {inputError}
                </p>
              )}
            </div>
            <Button type="submit" disabled={previewQuery.isFetching}>
              {previewQuery.isFetching ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Search className="mr-2 h-4 w-4" aria-hidden="true" />
              )}
              Load current preview
            </Button>
          </form>
        </CardContent>
      </Card>

      {previewQuery.error && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>Preview unavailable</AlertTitle>
          <AlertDescription>{previewQuery.error.message}</AlertDescription>
        </Alert>
      )}

      {preview && (
        <>
          <PreviewSummary preview={preview} />
          <EvidenceComparisonTable rows={comparisonRows} />

          {receipt ? (
            <Card className="border-emerald-300 bg-emerald-50/60 dark:bg-emerald-950/20">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-emerald-800 dark:text-emerald-300">
                  <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
                  {receipt.kind === "created"
                    ? "Immutable attestation recorded"
                    : "Exact attestation already existed"}
                </CardTitle>
                <CardDescription>
                  Attestation #{receipt.attestationId} linked immutable evidence to{" "}
                  {receipt.resolvedEventCount} historical label event
                  {receipt.resolvedEventCount === 1 ? "" : "s"}.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button type="button" variant="outline" onClick={resetReview}>
                  Review another label
                </Button>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>Lead attestation</CardTitle>
                <CardDescription>
                  The server will re-fetch and revalidate this evidence before writing. A changed
                  preview is rejected without recording anything.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                {!canAttest && (
                  <Alert>
                    <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                    <AlertTitle>View-only access</AlertTitle>
                    <AlertDescription>
                      Inventory adjustment permission is required to record an attestation.
                    </AlertDescription>
                  </Alert>
                )}

                <div className="space-y-2">
                  <Label htmlFor="attestation-reason">Review reason</Label>
                  <Textarea
                    id="attestation-reason"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    maxLength={500}
                    rows={4}
                    disabled={!canAttest || attestationMutation.isPending}
                    placeholder="State what was reviewed and why this historical evidence is authoritative."
                  />
                  <p className="text-right text-xs text-muted-foreground">{reason.length}/500</p>
                </div>

                <div className="flex items-start gap-3 rounded-md border p-4">
                  <Checkbox
                    id="historical-contents-review-confirmed"
                    checked={reviewConfirmed}
                    onCheckedChange={(checked) => setReviewConfirmed(checked === true)}
                    disabled={!canAttest || attestationMutation.isPending}
                  />
                  <Label
                    htmlFor="historical-contents-review-confirmed"
                    className="cursor-pointer font-normal leading-5"
                  >
                    I reviewed every WMS expected line and ShipStation attested line shown above and
                    authorize recording this immutable evidence.
                  </Label>
                </div>

                {readiness.issues.length > 0 && (
                  <ul className="space-y-1 text-sm text-muted-foreground">
                    {readiness.issues.map((issue) => <li key={issue}>• {issue}</li>)}
                  </ul>
                )}

                <Button
                  type="button"
                  onClick={() => attestationMutation.mutate()}
                  disabled={!readiness.ready || attestationMutation.isPending}
                >
                  {attestationMutation.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <FileCheck2 className="mr-2 h-4 w-4" aria-hidden="true" />
                  )}
                  Record immutable attestation
                </Button>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function PreviewSummary({
  preview,
}: {
  preview: HistoricalShipStationContentsAttestationPreview;
}) {
  const source = preview.expectedContents.kind === "available"
    ? preview.expectedContents.source.replaceAll("_", " ")
    : preview.expectedContents.reason.replaceAll("_", " ");
  const orders = preview.reviewContext.wmsOrders.length === 0
    ? "No linked WMS order"
    : preview.reviewContext.wmsOrders
        .map((order) => `${order.orderNumber} (WMS ${order.wmsOrderId})`)
        .join(", ");
  const shipments = preview.reviewContext.linkedShipments.length === 0
    ? "No linked WMS shipment"
    : preview.reviewContext.linkedShipments
        .map((shipment) => shipment.source === "physical_shipment"
          ? `Physical ${shipment.shipmentId}`
          : `WMS ${shipment.shipmentId}`)
        .join(", ");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <RefreshCw className="h-5 w-5" aria-hidden="true" />
          Shipment identity
        </CardTitle>
        <CardDescription>
          Confirm these operational references identify the shipment you intend to review.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <EvidenceField label="Order" value={orders} />
          <EvidenceField label="Tracking" value={preview.reviewContext.trackingNumber} />
          <EvidenceField label="Linked shipments" value={shipments} />
          <EvidenceField label="ShipStation shipment" value={String(preview.providerShipmentId)} />
          <EvidenceField
            label="ShipStation order"
            value={preview.reviewContext.shipStationOrderId ?? "Not recorded"}
          />
          <EvidenceField label="Internal label reference" value={preview.shippingProviderLabelId} />
        </dl>
        <div className="rounded-md border bg-muted/20 p-4">
          <p className="mb-3 text-sm text-muted-foreground">
            The fingerprint below is valid only while the candidate and provider evidence remain
            unchanged.
          </p>
          <dl className="grid gap-4 sm:grid-cols-2">
            <EvidenceField label="Provider evidence" value={preview.providerContentsStatus} />
            <EvidenceField label="WMS lineage" value={source} />
          </dl>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <HashField label="Preview fingerprint" value={preview.previewEvidenceHash} />
            <HashField label="Provider evidence hash" value={preview.providerEvidenceHash} />
          </div>
          <Badge className="mt-4" variant="outline">
            Recovery: {preview.recoveryStatus.replaceAll("_", " ")}
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}

function EvidenceComparisonTable({
  rows,
}: {
  rows: ReturnType<typeof historicalContentsComparisonRows>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>WMS versus ShipStation</CardTitle>
        <CardDescription>
          Product names and SKUs are for recognition. Comparison still uses the immutable WMS line
          identity shown beneath each item.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">WMS quantity</TableHead>
                <TableHead className="text-right">ShipStation quantity</TableHead>
                <TableHead>Comparison</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.wmsShipmentItemId}>
                  <TableCell>
                    <div className="font-medium">
                      {row.itemName ?? row.sku ?? "Not present in WMS evidence"}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {row.sku === null ? "SKU unavailable" : `SKU ${row.sku}`}
                      {` · WMS line ${row.wmsShipmentItemId}`}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">{row.expectedQuantity ?? "—"}</TableCell>
                  <TableCell className="text-right">{row.attestedQuantity ?? "—"}</TableCell>
                  <TableCell><ComparisonBadge status={row.status} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function ComparisonBadge({ status }: { status: HistoricalContentsComparisonStatus }) {
  if (status === "match") {
    return <Badge className="bg-emerald-600 hover:bg-emerald-600">Exact match</Badge>;
  }
  const label = status === "quantity_mismatch"
    ? "Quantity differs"
    : status === "missing_from_shipstation"
      ? "Missing from ShipStation"
      : "Missing from WMS";
  return <Badge variant="destructive">{label}</Badge>;
}

function EvidenceField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-medium capitalize">{value.replaceAll("_", " ")}</dd>
    </div>
  );
}

function HashField({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-muted/40 p-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 break-all font-mono text-xs">{value}</div>
    </div>
  );
}
