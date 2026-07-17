/**
 * Create / edit a pricing program: business name plus explicit "Used by"
 * assignments (channel · purpose · warehouse scope). Cross-program conflicts
 * come back from the API as actionable 409s and render inline.
 */

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Trash2 } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  CHANNEL_CHOICES,
  PURPOSE_CHOICES,
  invalidateShippingAdmin,
  postJson,
  putJson,
  type RateBookSummary,
  type WarehouseOption,
} from "./api";

interface AssignmentDraft {
  key: string;
  pricingChannel: string;
  ratePurpose: string;
  originWarehouseId: number | null;
}

interface ProgramFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  warehouses: WarehouseOption[];
  /** Present = edit mode; absent = create mode. */
  program?: RateBookSummary | null;
  onSaved: (rateBookId: number) => void;
}

let assignmentCounter = 0;
function nextKey(): string {
  assignmentCounter += 1;
  return `assignment-${assignmentCounter}`;
}

export function ProgramFormDialog({
  open,
  onOpenChange,
  warehouses,
  program = null,
  onSaved,
}: ProgramFormDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [assignments, setAssignments] = useState<AssignmentDraft[]>([]);
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setServerError(null);
    setName(program?.name ?? "");
    setAssignments(
      (program?.assignments ?? [])
        .filter((assignment) => assignment.isActive)
        .map((assignment) => ({
          key: nextKey(),
          pricingChannel: assignment.pricingChannel,
          ratePurpose: assignment.ratePurpose,
          originWarehouseId: assignment.originWarehouseId,
        })),
    );
  }, [open, program]);

  const saveMutation = useMutation({
    mutationFn: () => {
      const payload = {
        name: name.trim(),
        assignments: assignments.map((assignment) => ({
          pricingChannel: assignment.pricingChannel,
          ratePurpose: assignment.ratePurpose,
          originWarehouseId: assignment.originWarehouseId,
        })),
      };
      return program === null
        ? postJson<{ rateBook: { id: number } }>("/api/shipping/admin/rate-books", payload)
        : putJson<{ rateBook: { id: number } }>(`/api/shipping/admin/rate-books/${program.id}`, payload);
    },
    onSuccess: (result) => {
      invalidateShippingAdmin(queryClient);
      toast({ title: program === null ? "Pricing program created" : "Pricing program updated" });
      onOpenChange(false);
      onSaved(result.rateBook.id);
    },
    onError: (error: Error) => {
      setServerError(error.message);
    },
  });

  const addAssignment = () => {
    setAssignments((current) => [...current, {
      key: nextKey(),
      pricingChannel: "shopify",
      ratePurpose: "customer_checkout",
      originWarehouseId: null,
    }]);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {program === null ? "Create pricing program" : "Edit pricing program"}
          </DialogTitle>
          <DialogDescription>
            A pricing program is a named collection of shipping prices used by the checkout or
            fulfillment flows you assign to it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="program-name">Program name</Label>
            <Input
              id="program-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Dropship Vendor Fulfillment Rates"
              maxLength={160}
            />
          </div>

          <div className="space-y-2">
            <div>
              <Label>Used by</Label>
              <p className="text-xs text-muted-foreground">
                Each scope (channel · purpose · warehouse) can be served by exactly one program
                at a time.
              </p>
            </div>
            {assignments.length === 0 && (
              <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                No assignments yet — the program can hold rates but nothing quotes from it.
              </p>
            )}
            {assignments.map((assignment) => (
              <div
                key={assignment.key}
                className="grid gap-2 sm:grid-cols-[1fr_1.4fr_1fr_auto]"
              >
                <Select
                  value={assignment.pricingChannel}
                  onValueChange={(value) => setAssignments((current) => current.map((item) =>
                    item.key === assignment.key ? { ...item, pricingChannel: value } : item))}
                >
                  <SelectTrigger className="h-9" aria-label="Channel"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CHANNEL_CHOICES.map((choice) => (
                      <SelectItem key={choice.value} value={choice.value}>{choice.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={assignment.ratePurpose}
                  onValueChange={(value) => setAssignments((current) => current.map((item) =>
                    item.key === assignment.key ? { ...item, ratePurpose: value } : item))}
                >
                  <SelectTrigger className="h-9" aria-label="Purpose"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PURPOSE_CHOICES.map((choice) => (
                      <SelectItem key={choice.value} value={choice.value}>{choice.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={assignment.originWarehouseId === null ? "all" : String(assignment.originWarehouseId)}
                  onValueChange={(value) => setAssignments((current) => current.map((item) =>
                    item.key === assignment.key
                      ? { ...item, originWarehouseId: value === "all" ? null : Number(value) }
                      : item))}
                >
                  <SelectTrigger className="h-9" aria-label="Warehouse scope"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All warehouses</SelectItem>
                    {warehouses.map((warehouse) => (
                      <SelectItem key={warehouse.id} value={String(warehouse.id)}>
                        {warehouse.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9"
                  aria-label="Remove assignment"
                  onClick={() => setAssignments((current) =>
                    current.filter((item) => item.key !== assignment.key))}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={addAssignment}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Add assignment
            </Button>
          </div>

          {serverError && (
            <p className="rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {serverError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={name.trim() === "" || saveMutation.isPending}
          >
            {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {program === null ? "Create program" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
