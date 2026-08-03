import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, Loader2, Pencil, Plus, Save, Trash2 } from "lucide-react";
import type {
  ShippingDestinationScopeMember,
  ShippingDestinationScopeSummary,
} from "@shared/types/shipping-channel-routing";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import {
  CHANNEL_ROUTING_KEY,
  createDeliveryRegion,
  retireDeliveryRegion,
  updateDeliveryRegion,
} from "./api";

interface RegionForm {
  id: number | null;
  lockVersion: number | null;
  code: string;
  name: string;
  members: ShippingDestinationScopeMember[];
}

const EMPTY_MEMBER: ShippingDestinationScopeMember = {
  country: "US",
  region: null,
  postalPrefix: null,
};

export function DeliveryRegionsPanel({
  scopes,
}: {
  scopes: ShippingDestinationScopeSummary[];
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<RegionForm | null>(null);
  const [retiring, setRetiring] = useState<ShippingDestinationScopeSummary | null>(null);

  const saveMutation = useMutation({
    mutationFn: async (input: RegionForm) => {
      if (input.id === null) {
        return createDeliveryRegion({
          code: input.code,
          name: input.name,
          members: input.members,
        });
      }
      if (input.lockVersion === null) {
        throw new Error("Destination version is missing.");
      }
      return updateDeliveryRegion({
        scopeId: input.id,
        expectedLockVersion: input.lockVersion,
        code: input.code,
        name: input.name,
        members: input.members,
      });
    },
    onSuccess: () => {
      setForm(null);
      void queryClient.invalidateQueries({ queryKey: [CHANNEL_ROUTING_KEY] });
      toast({ title: "Destination saved" });
    },
    onError: (error) => {
      toast({
        title: "Destination was not saved",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    },
  });
  const retireMutation = useMutation({
    mutationFn: retireDeliveryRegion,
    onSuccess: () => {
      setRetiring(null);
      void queryClient.invalidateQueries({ queryKey: [CHANNEL_ROUTING_KEY] });
      toast({ title: "Destination retired" });
    },
    onError: (error) => {
      toast({
        title: "Destination was not retired",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    },
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Destinations</h2>
          <p className="text-sm text-muted-foreground">
            Reusable country, state, and postal coverage shared by pricing, channels, and membership benefits.
          </p>
        </div>
        <Button onClick={() => setForm(emptyForm())}>
          <Plus className="mr-2 h-4 w-4" />
          New destination
        </Button>
      </div>

      <div className="overflow-x-auto border">
        <Table className="min-w-[48rem]">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Code</TableHead>
              <TableHead>Coverage</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-28 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {scopes.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-28 text-center text-muted-foreground">
                  No destinations have been created.
                </TableCell>
              </TableRow>
            ) : scopes.map((scope) => (
              <TableRow key={scope.id}>
                <TableCell className="font-medium">{scope.name}</TableCell>
                <TableCell className="font-mono text-xs">{scope.code}</TableCell>
                <TableCell>
                  <div>{scope.members.length} destination{scope.members.length === 1 ? "" : "s"}</div>
                  <div className="max-w-96 truncate text-xs text-muted-foreground">
                    {scope.members.map(formatMember).join(", ")}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge
                    variant={scope.status === "active" ? "outline" : "secondary"}
                    className="capitalize"
                  >
                    {scope.status}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    {scope.status !== "retired" && (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Edit destination"
                          onClick={() => setForm(formFromScope(scope))}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Retire destination"
                          onClick={() => setRetiring(scope)}
                        >
                          <Archive className="h-4 w-4" />
                        </Button>
                      </>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <RegionEditorDialog
        form={form}
        saving={saveMutation.isPending}
        onChange={setForm}
        onSave={() => {
          if (form) saveMutation.mutate(form);
        }}
      />

      <AlertDialog
        open={retiring !== null}
        onOpenChange={(open) => {
          if (!open && !retireMutation.isPending) setRetiring(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Retire this destination?</AlertDialogTitle>
            <AlertDialogDescription>
              Existing active policies keep their frozen destination coverage.
              New drafts cannot select this destination.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={retireMutation.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={retireMutation.isPending}
              onClick={() => {
                if (retiring) {
                  retireMutation.mutate({
                    scopeId: retiring.id,
                    expectedLockVersion: retiring.lockVersion,
                  });
                }
              }}
            >
              {retireMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Retire destination
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function RegionEditorDialog({
  form,
  saving,
  onChange,
  onSave,
}: {
  form: RegionForm | null;
  saving: boolean;
  onChange: (form: RegionForm | null) => void;
  onSave: () => void;
}) {
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    setValidationError(null);
  }, [form?.id]);

  const updateMember = (
    index: number,
    patch: Partial<ShippingDestinationScopeMember>,
  ) => {
    if (!form) return;
    onChange({
      ...form,
      members: form.members.map((member, memberIndex) =>
        memberIndex === index ? { ...member, ...patch } : member),
    });
  };

  return (
    <Dialog
      open={form !== null}
      onOpenChange={(open) => {
        if (!open && !saving) onChange(null);
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {form?.id === null ? "New destination" : "Edit destination"}
          </DialogTitle>
          <DialogDescription>
            Country is required. State and postal prefix narrow that country.
          </DialogDescription>
        </DialogHeader>

        {form && (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="region-name">Name</Label>
                <Input
                  id="region-name"
                  value={form.name}
                  maxLength={160}
                  onChange={(event) => onChange({
                    ...form,
                    name: event.target.value,
                  })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="region-code">Code</Label>
                <Input
                  id="region-code"
                  value={form.code}
                  maxLength={100}
                  placeholder="lower-48"
                  onChange={(event) => onChange({
                    ...form,
                    code: event.target.value.toLowerCase().replaceAll(" ", "-"),
                  })}
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="grid grid-cols-[7rem_1fr_1fr_2.5rem] gap-2 px-1 text-xs font-medium text-muted-foreground">
                <span>Country</span>
                <span>State / region</span>
                <span>Postal prefix</span>
                <span />
              </div>
              {form.members.map((member, index) => (
                <div
                  key={index}
                  className="grid grid-cols-[7rem_1fr_1fr_2.5rem] gap-2"
                >
                  <Input
                    aria-label={`Destination ${index + 1} country`}
                    value={member.country}
                    maxLength={2}
                    onChange={(event) => updateMember(index, {
                      country: event.target.value.toUpperCase(),
                    })}
                  />
                  <Input
                    aria-label={`Destination ${index + 1} state or region`}
                    value={member.region ?? ""}
                    maxLength={10}
                    placeholder="All"
                    onChange={(event) => updateMember(index, {
                      region: emptyToNull(event.target.value.toUpperCase()),
                    })}
                  />
                  <Input
                    aria-label={`Destination ${index + 1} postal prefix`}
                    value={member.postalPrefix ?? ""}
                    maxLength={20}
                    placeholder="All"
                    onChange={(event) => updateMember(index, {
                      postalPrefix: emptyToNull(event.target.value.toUpperCase()),
                    })}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    title="Remove destination"
                    disabled={form.members.length === 1}
                    onClick={() => onChange({
                      ...form,
                      members: form.members.filter((_, memberIndex) =>
                        memberIndex !== index),
                    })}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                onClick={() => onChange({
                  ...form,
                  members: [...form.members, { ...EMPTY_MEMBER }],
                })}
              >
                <Plus className="mr-2 h-4 w-4" />
                Add destination
              </Button>
            </div>

            {validationError && (
              <p className="text-sm text-destructive">{validationError}</p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            disabled={saving}
            onClick={() => onChange(null)}
          >
            Cancel
          </Button>
          <Button
            disabled={saving}
            onClick={() => {
              const error = form ? validateForm(form) : "Region is missing.";
              setValidationError(error);
              if (!error) onSave();
            }}
          >
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            Save destination
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function emptyForm(): RegionForm {
  return {
    id: null,
    lockVersion: null,
    code: "",
    name: "",
    members: [{ ...EMPTY_MEMBER }],
  };
}

function formFromScope(scope: ShippingDestinationScopeSummary): RegionForm {
  return {
    id: scope.id,
    lockVersion: scope.lockVersion,
    code: scope.code,
    name: scope.name,
    members: scope.members.map((member) => ({ ...member })),
  };
}

function validateForm(form: RegionForm): string | null {
  if (form.name.trim() === "") return "Name is required.";
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(form.code.trim())) {
    return "Code must contain lowercase letters, numbers, and hyphens.";
  }
  if (form.members.some((member) => !/^[A-Z]{2}$/.test(member.country))) {
    return "Every destination requires a two-letter country code.";
  }
  return null;
}

function formatMember(member: ShippingDestinationScopeMember): string {
  return [
    member.country,
    member.region,
    member.postalPrefix ? `postal ${member.postalPrefix}` : null,
  ].filter(Boolean).join(" ");
}

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
