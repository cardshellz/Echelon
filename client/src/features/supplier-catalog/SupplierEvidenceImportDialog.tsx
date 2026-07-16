import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Loader2,
  Upload,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import {
  MAX_SUPPLIER_EVIDENCE_CSV_BYTES,
  parseSupplierEvidenceCsv,
  supplierEvidenceImportTemplateCsv,
  type SupplierEvidenceCsvError,
  type SupplierEvidenceImportApiRow,
} from "./supplierEvidenceImport";

type SupplierOption = {
  id: number;
  code: string;
  name: string;
  active: number;
};

type SupplierEvidencePreviewItem = {
  rowNumber: number;
  sku: string;
  productName: string;
  variantName: string | null;
  action: "create" | "update" | "reactivate";
  existingVendorProductId: number | null;
  willDemoteVendorProductIds: number[];
  pricingBasis: "per_piece" | "per_purchase_uom";
  quotedUnitCost: string;
  purchaseUom: string | null;
  piecesPerPurchaseUom: number | null;
  quoteReference: string | null;
  quotedAt: string;
  quoteValidUntil: string | null;
  quoteValidityStatus: "current" | "missing" | "invalid" | "future" | "expired" | "stale";
  moqPieces: number;
  leadTimeDays: number;
  isPreferred: boolean;
  warnings: string[];
};

type SupplierEvidencePreview = {
  contractVersion: number;
  generatedAt: string;
  previewHash: string;
  vendor: { id: number; code: string; name: string };
  summary: {
    total: number;
    creates: number;
    updates: number;
    reactivations: number;
    preferredDemotions: number;
    warnings: number;
  };
  items: SupplierEvidencePreviewItem[];
};

type Props = {
  open: boolean;
  vendors: SupplierOption[];
  initialVendorId?: number | null;
  onOpenChange(open: boolean): void;
  onApplied(result: unknown): void;
};

function importIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `supplier-evidence-import-${crypto.randomUUID()}`;
  }
  return `supplier-evidence-import-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function actionClass(action: SupplierEvidencePreviewItem["action"]): string {
  if (action === "create") return "border-green-200 bg-green-50 text-green-700";
  if (action === "reactivate") return "border-blue-200 bg-blue-50 text-blue-700";
  return "border-zinc-200 bg-zinc-50 text-zinc-700";
}

function formatQuote(item: SupplierEvidencePreviewItem): string {
  if (item.pricingBasis === "per_piece") return `$${item.quotedUnitCost} / piece`;
  return `$${item.quotedUnitCost} / ${item.purchaseUom} (${item.piecesPerPurchaseUom} pieces)`;
}

async function responseBody(response: Response): Promise<any> {
  return response.json().catch(() => null);
}

export function SupplierEvidenceImportDialog({
  open,
  vendors,
  initialVendorId,
  onOpenChange,
  onApplied,
}: Props) {
  const { toast } = useToast();
  const [vendorId, setVendorId] = useState<string>("");
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<SupplierEvidenceImportApiRow[]>([]);
  const [errors, setErrors] = useState<SupplierEvidenceCsvError[]>([]);
  const [preview, setPreview] = useState<SupplierEvidencePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [applyIdempotencyKey, setApplyIdempotencyKey] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setVendorId(initialVendorId ? String(initialVendorId) : "");
    setFileName("");
    setRows([]);
    setErrors([]);
    setPreview(null);
    setPreviewing(false);
    setApplying(false);
    setConfirmed(false);
    setApplyIdempotencyKey(null);
  }, [open, initialVendorId]);

  const activeVendors = vendors.filter((vendor) => vendor.active === 1);

  const resetPreview = () => {
    setPreview(null);
    setConfirmed(false);
    setApplyIdempotencyKey(null);
  };

  const downloadTemplate = () => {
    const blob = new Blob([supplierEvidenceImportTemplateCsv()], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "echelon-supplier-evidence-template.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const loadCsv = async (file: File | undefined) => {
    resetPreview();
    if (!file) {
      setFileName("");
      setRows([]);
      setErrors([]);
      return;
    }
    if (file.size > MAX_SUPPLIER_EVIDENCE_CSV_BYTES) {
      setFileName(file.name);
      setRows([]);
      setErrors([{
        rowNumber: 0,
        message: "The CSV is larger than 1 MB. Split it into batches of 200 rows or fewer.",
      }]);
      return;
    }
    const result = parseSupplierEvidenceCsv(await file.text());
    setFileName(file.name);
    setRows(result.rows);
    setErrors(result.errors);
  };

  const previewImport = async () => {
    const parsedVendorId = Number(vendorId);
    if (!Number.isSafeInteger(parsedVendorId) || parsedVendorId <= 0 || rows.length === 0) return;
    setPreviewing(true);
    setErrors([]);
    setPreview(null);
    setConfirmed(false);
    try {
      const response = await fetch("/api/purchasing/supplier-evidence-import/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendorId: parsedVendorId, rows }),
      });
      const body = await responseBody(response);
      if (!response.ok) {
        const rowErrors = Array.isArray(body?.details?.errors)
          ? body.details.errors.map((error: any) => ({
              rowNumber: Number(error.rowNumber) || 0,
              field: error.field,
              message: error.message ?? error.code ?? "Invalid supplier evidence row",
            }))
          : [];
        if (rowErrors.length > 0) setErrors(rowErrors);
        throw new Error(body?.error ?? "Failed to preview supplier evidence");
      }
      setPreview(body);
      setApplyIdempotencyKey(importIdempotencyKey());
    } catch (error) {
      toast({
        title: "Supplier evidence preview failed",
        description: error instanceof Error ? error.message : "Review the CSV and try again.",
        variant: "destructive",
      });
    } finally {
      setPreviewing(false);
    }
  };

  const applyImport = async () => {
    if (!preview || !confirmed) return;
    setApplying(true);
    const idempotencyKey = applyIdempotencyKey ?? importIdempotencyKey();
    if (!applyIdempotencyKey) setApplyIdempotencyKey(idempotencyKey);
    try {
      const response = await fetch("/api/purchasing/supplier-evidence-import/apply", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          vendorId: preview.vendor.id,
          rows,
          previewHash: preview.previewHash,
        }),
      });
      const body = await responseBody(response);
      if (!response.ok) {
        if (body?.details?.code === "SUPPLIER_EVIDENCE_PREVIEW_STALE") {
          setPreview(null);
          setConfirmed(false);
          setApplyIdempotencyKey(null);
        }
        throw new Error(body?.error ?? "Failed to apply supplier evidence");
      }
      toast({
        title: "Supplier evidence applied",
        description: `${preview.summary.total} mapping${preview.summary.total === 1 ? "" : "s"} updated atomically for ${preview.vendor.name}.`,
      });
      onApplied(body);
      onOpenChange(false);
    } catch (error) {
      toast({
        title: "Supplier evidence was not applied",
        description: error instanceof Error ? error.message : "No catalog rows were intentionally changed.",
        variant: "destructive",
      });
    } finally {
      setApplying(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !applying && onOpenChange(next)}>
      <DialogContent className="max-h-[92vh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import verified supplier evidence</DialogTitle>
          <DialogDescription>
            Preview exact supplier quotes, lead time, MOQ, and preferred-vendor changes before one atomic catalog update. One CSV applies to one supplier.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
            Enter the quote exactly as the supplier provided it. Use <code>per_piece</code> for a per-piece quote or <code>per_purchase_uom</code> for a case, roll, pallet, or other quoted UOM. Never enter a line-item extended total as reusable catalog pricing.
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Supplier</Label>
              <Select
                value={vendorId}
                onValueChange={(value) => {
                  setVendorId(value);
                  resetPreview();
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select the supplier for this CSV" />
                </SelectTrigger>
                <SelectContent>
                  {activeVendors.map((vendor) => (
                    <SelectItem key={vendor.id} value={String(vendor.id)}>
                      {vendor.code} — {vendor.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="supplier-evidence-csv">Verified evidence CSV</Label>
              <Input
                id="supplier-evidence-csv"
                type="file"
                accept=".csv,text/csv"
                onChange={(event) => void loadCsv(event.target.files?.[0])}
              />
              {fileName ? <p className="text-xs text-muted-foreground">{fileName}</p> : null}
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={downloadTemplate}>
              <Download className="mr-2 h-4 w-4" />
              Download CSV template
            </Button>
            <Button
              type="button"
              disabled={!vendorId || rows.length === 0 || errors.length > 0 || previewing}
              onClick={() => void previewImport()}
            >
              {previewing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
              Preview {rows.length || ""} row{rows.length === 1 ? "" : "s"}
            </Button>
          </div>

          {errors.length > 0 ? (
            <div className="rounded-md border border-red-200 bg-red-50 p-3">
              <div className="flex items-center gap-2 font-medium text-red-800">
                <AlertTriangle className="h-4 w-4" />
                Fix {errors.length} CSV issue{errors.length === 1 ? "" : "s"} before preview
              </div>
              <ul className="mt-2 max-h-40 list-disc space-y-1 overflow-y-auto pl-5 text-xs text-red-700">
                {errors.slice(0, 50).map((error, index) => (
                  <li key={`${error.rowNumber}-${error.field ?? "row"}-${index}`}>
                    Row {error.rowNumber}{error.field ? `, ${error.field}` : ""}: {error.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : rows.length > 0 && !preview ? (
            <div className="flex items-center gap-2 rounded-md border bg-muted/30 p-3 text-sm">
              <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
              {rows.length} valid CSV row{rows.length === 1 ? "" : "s"} loaded. Preview is read-only.
            </div>
          ) : null}

          {preview ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
                {[
                  ["Rows", preview.summary.total],
                  ["Create", preview.summary.creates],
                  ["Update", preview.summary.updates],
                  ["Reactivate", preview.summary.reactivations],
                  ["Demotions", preview.summary.preferredDemotions],
                  ["Warnings", preview.summary.warnings],
                ].map(([label, value]) => (
                  <div key={String(label)} className="rounded-md border bg-muted/20 p-2 text-center">
                    <div className="text-lg font-semibold">{value}</div>
                    <div className="text-[11px] text-muted-foreground">{label}</div>
                  </div>
                ))}
              </div>

              <div className="max-h-[360px] overflow-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>SKU</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead>Verified quote</TableHead>
                      <TableHead>Lead / MOQ</TableHead>
                      <TableHead>Evidence</TableHead>
                      <TableHead>Warnings</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.items.map((item) => (
                      <TableRow key={`${item.rowNumber}-${item.sku}`}>
                        <TableCell>
                          <div className="font-mono text-xs font-semibold">{item.sku}</div>
                          <div className="max-w-[220px] truncate text-xs text-muted-foreground">
                            {item.variantName ?? item.productName}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={actionClass(item.action)}>
                            {item.action}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs">
                          <div className="font-medium">{formatQuote(item)}</div>
                          <div className="text-muted-foreground">
                            {item.isPreferred ? "Preferred supplier" : "Not preferred"}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs">
                          <div>{item.leadTimeDays} days</div>
                          <div className="text-muted-foreground">MOQ {item.moqPieces} pieces</div>
                        </TableCell>
                        <TableCell className="text-xs">
                          <div>{new Date(item.quotedAt).toLocaleDateString()}</div>
                          <div className="max-w-[180px] truncate text-muted-foreground">
                            {item.quoteReference ?? "No quote reference"}
                          </div>
                          <div className={item.quoteValidityStatus === "current" ? "text-green-700" : "text-amber-700"}>
                            Quote {item.quoteValidityStatus}
                          </div>
                        </TableCell>
                        <TableCell className="max-w-[240px] text-xs">
                          {item.warnings.length === 0 ? (
                            <span className="inline-flex items-center gap-1 text-green-700">
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              None
                            </span>
                          ) : (
                            <ul className="space-y-1 text-amber-700">
                              {item.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                            </ul>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3">
                <Checkbox
                  id="confirm-supplier-evidence-import"
                  checked={confirmed}
                  onCheckedChange={(checked) => setConfirmed(Boolean(checked))}
                />
                <Label htmlFor="confirm-supplier-evidence-import" className="cursor-pointer font-normal text-amber-950">
                  I verified these values against supplier evidence and approve all listed creates, updates, reactivations, and preferred-supplier demotions. Applying does not create a purchase order or weaken automatic-purchasing policy.
                </Label>
              </div>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" disabled={applying} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={!preview || !confirmed || applying} onClick={() => void applyImport()}>
            {applying ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Apply atomically
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
