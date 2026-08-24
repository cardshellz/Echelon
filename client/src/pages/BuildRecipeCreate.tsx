import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, ArrowLeftRight, Check, Hammer, Loader2, Plus, X } from "lucide-react";
import { useLocation, useRoute } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useToast } from "@/hooks/use-toast";
import { BuildVariantSelector } from "@/features/inventory-builds/BuildVariantSelector";
import {
  calculateRecipeEvidence,
  type BuildVariantResult,
  type RecipeComponentDraft,
  type RecipeType,
} from "@/features/inventory-builds/build-recipe-model";

type RecipeComponentView = {
  id: number;
  componentVariantId: number;
  componentProductId: number;
  componentUnitsPerVariant: number;
  sku: string | null;
  name: string;
  qtyPerBuild: number;
};

type BuildRecipeView = {
  id: number;
  code: string;
  name: string;
  version: number;
  status: "draft" | "active" | "retired";
  recipeType: RecipeType;
  outputVariantId: number;
  outputProductId: number;
  outputUnitsPerVariant: number;
  outputSku: string | null;
  outputName: string;
  outputQty: number;
  notes: string | null;
  createdBy: string | null;
  supersedesRecipeId: number | null;
  changeReason: string | null;
  retiredBy: string | null;
  retiredAt: string | null;
  createdAt: string;
  updatedAt: string;
  components: RecipeComponentView[];
};

type RecipeSaveResult = {
  version: number;
};

function recipeVariant(input: {
  variantId: number;
  productId: number;
  unitsPerVariant: number;
  sku: string | null;
  name: string;
}): BuildVariantResult {
  return {
    productVariantId: input.variantId,
    productId: input.productId,
    unitsPerVariant: input.unitsPerVariant,
    sku: input.sku ?? input.name,
    name: input.name,
  };
}

function createIdempotencyKey(recipeId: number): string {
  return `build-recipe-${recipeId}-${crypto.randomUUID()}`;
}

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? body?.error ?? `Request failed (${response.status}).`);
  return body as T;
}

function SectionHeading({ number, title, detail }: { number: number; title: string; detail: string }) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center border bg-muted text-sm font-semibold">{number}</div>
      <div>
        <h2 className="font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

export default function BuildRecipeCreate() {
  const [, navigate] = useLocation();
  const [, editParams] = useRoute("/inventory/builds/recipes/:recipeId/edit");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const recipeId = editParams?.recipeId == null ? null : Number(editParams.recipeId);
  const isEditing = Number.isSafeInteger(recipeId) && Number(recipeId) > 0;
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState<"draft" | "active">("active");
  const [recipeType, setRecipeType] = useState<RecipeType>("assembly");
  const [outputVariant, setOutputVariant] = useState<BuildVariantResult | null>(null);
  const [outputQty, setOutputQty] = useState("1");
  const [changeReason, setChangeReason] = useState("");
  const [nextComponentKey, setNextComponentKey] = useState(2);
  const [components, setComponents] = useState<RecipeComponentDraft[]>([
    { key: 1, variant: null, qtyPerBuild: "1" },
  ]);
  const hydratedRecipeId = useRef<number | null>(null);
  const editIdempotencyKey = useRef<string | null>(null);

  const { data: recipes = [], isLoading: recipesLoading } = useQuery<BuildRecipeView[]>({
    queryKey: ["/api/inventory/build-recipes"],
    queryFn: async () => responseJson(await fetch("/api/inventory/build-recipes", { credentials: "include" })),
    enabled: isEditing,
  });
  const recipe = isEditing ? recipes.find((item) => item.id === recipeId) ?? null : null;
  const versionHistory = useMemo(
    () => recipe == null
      ? []
      : recipes
        .filter((item) => item.code === recipe.code)
        .sort((left, right) => right.version - left.version),
    [recipe, recipes],
  );
  const isLatestVersion = !isEditing || (recipe != null && versionHistory[0]?.id === recipe.id);

  useEffect(() => {
    if (!recipe || hydratedRecipeId.current === recipe.id) return;
    setCode(recipe.code);
    setName(recipe.name);
    setNotes(recipe.notes ?? "");
    setStatus(recipe.status === "draft" ? "draft" : "active");
    setRecipeType(recipe.recipeType);
    setOutputVariant(recipeVariant({
      variantId: recipe.outputVariantId,
      productId: recipe.outputProductId,
      unitsPerVariant: recipe.outputUnitsPerVariant,
      sku: recipe.outputSku,
      name: recipe.outputName,
    }));
    setOutputQty(String(recipe.outputQty));
    setComponents(recipe.components.map((component, index) => ({
      key: index + 1,
      variant: recipeVariant({
        variantId: component.componentVariantId,
        productId: component.componentProductId,
        unitsPerVariant: component.componentUnitsPerVariant,
        sku: component.sku,
        name: component.name,
      }),
      qtyPerBuild: String(component.qtyPerBuild),
    })));
    setNextComponentKey(recipe.components.length + 1);
    setChangeReason("");
    hydratedRecipeId.current = recipe.id;
  }, [recipe]);

  const evidence = useMemo(() => calculateRecipeEvidence({
    recipeType,
    outputVariant,
    outputQty,
    components,
  }), [components, outputQty, outputVariant, recipeType]);
  const valid = Boolean(
    code.trim()
    && name.trim()
    && evidence?.valid
    && (!isEditing || (recipe && isLatestVersion && changeReason.trim())),
  );
  const editCommandSignature = useMemo(() => JSON.stringify({
    recipeId,
    name: name.trim(),
    notes: notes.trim(),
    status,
    recipeType,
    outputVariantId: outputVariant?.productVariantId ?? null,
    outputQty,
    changeReason: changeReason.trim(),
    components: components.map((component) => ({
      componentVariantId: component.variant?.productVariantId ?? null,
      qtyPerBuild: component.qtyPerBuild,
    })),
  }), [changeReason, components, name, notes, outputQty, outputVariant, recipeId, recipeType, status]);

  useEffect(() => {
    editIdempotencyKey.current = null;
  }, [editCommandSignature]);

  const saveRecipe = useMutation({
    mutationFn: async () => {
      const body = {
        name: name.trim(),
        status,
        recipeType,
        outputVariantId: outputVariant?.productVariantId,
        outputQty: Number(outputQty),
        notes: notes.trim() || undefined,
        components: components.map((component) => ({
          componentVariantId: component.variant?.productVariantId,
          qtyPerBuild: Number(component.qtyPerBuild),
        })),
      };
      if (!isEditing || recipe == null) {
        return responseJson<RecipeSaveResult>(await fetch("/api/inventory/build-recipes", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, code: code.trim() }),
        }));
      }

      const idempotencyKey = editIdempotencyKey.current ?? createIdempotencyKey(recipe.id);
      editIdempotencyKey.current = idempotencyKey;
      return responseJson<RecipeSaveResult>(await fetch(`/api/inventory/build-recipes/${recipe.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          ...body,
          expectedVersion: recipe.version,
          changeReason: changeReason.trim(),
        }),
      }));
    },
    onSuccess: async (savedRecipe) => {
      editIdempotencyKey.current = null;
      await queryClient.invalidateQueries({ queryKey: ["/api/inventory/build-recipes"] });
      toast({
        title: isEditing
          ? `Recipe version ${savedRecipe.version} saved`
          : "Build recipe created",
      });
      navigate("/inventory/builds?tab=recipes");
    },
    onError: (error: Error) => toast({
      title: isEditing ? "Recipe update failed" : "Recipe creation failed",
      description: error.message,
      variant: "destructive",
    }),
  });

  if (isEditing && recipesLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading recipe...</div>;
  }
  if (isEditing && !recipe) {
    return (
      <div className="space-y-3 p-6">
        <h1 className="text-xl font-semibold">Recipe not found</h1>
        <Button variant="outline" onClick={() => navigate("/inventory/builds?tab=recipes")}>
          <ArrowLeft className="mr-2 h-4 w-4" />Back to Builds
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-3 md:p-6">
      <header className="flex flex-col justify-between gap-4 border-b pb-5 sm:flex-row sm:items-start">
        <div>
          <Button variant="ghost" className="mb-2 px-0" onClick={() => navigate("/inventory/builds?tab=recipes")}>
            <ArrowLeft className="mr-2 h-4 w-4" />Back to Builds
          </Button>
          <h1 className="text-2xl font-bold">{isEditing ? `Edit ${code}` : "Create build recipe"}</h1>
          <p className="text-sm text-muted-foreground">{isEditing ? "Save changes as a new immutable recipe version. Existing build orders retain their original version." : "Define a versioned, repeatable transformation from component inventory into an output SKU."}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => navigate("/inventory/builds?tab=recipes")}>Cancel</Button>
          <Button disabled={!valid || saveRecipe.isPending} onClick={() => saveRecipe.mutate()}>
            {saveRecipe.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{isEditing ? "Save new version" : "Create recipe"}
          </Button>
        </div>
      </header>
      {isEditing && !isLatestVersion && (
        <div className="flex gap-3 border border-red-300 bg-red-50 p-4 text-red-950">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <div className="font-medium">This is historical version {recipe?.version} and cannot be edited.</div>
            <div className="text-sm">Open version {versionHistory[0]?.version} from the recipe list before making another change.</div>
          </div>
        </div>
      )}


      <section className="space-y-5 border-b pb-6">
        <SectionHeading number={1} title="Recipe identity" detail="Name the operational rule and choose how it should be classified." />
        <div className="grid gap-4 pl-0 md:grid-cols-2 md:pl-10">
          <div><Label>Recipe code *</Label><Input value={code} onChange={(event) => setCode(event.target.value)} placeholder="QUAD-BOX-TOP-EA" disabled={isEditing} /><p className="mt-1 text-xs text-muted-foreground">{isEditing ? "Recipe code is the permanent identity shared by all versions." : "Use a stable operational code; it cannot be changed after creation."}</p></div>
          <div><Label>Name *</Label><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Assemble Quad Box Toploader" /></div>
          <div className="md:col-span-2">
            <Label>Recipe type *</Label>
            <ToggleGroup
              type="single"
              value={recipeType}
              onValueChange={(value) => {
                if (value === "conversion" || value === "assembly") setRecipeType(value);
              }}
              variant="outline"
              className="mt-1 grid grid-cols-2 justify-stretch"
            >
              <ToggleGroupItem value="conversion" className="h-auto w-full py-3">
                <ArrowLeftRight className="mr-2 h-4 w-4" />Conversion
                <span className="ml-2 hidden text-xs text-muted-foreground sm:inline">same product, different pack size</span>
              </ToggleGroupItem>
              <ToggleGroupItem value="assembly" className="h-auto w-full py-3">
                <Hammer className="mr-2 h-4 w-4" />Assembly
                <span className="ml-2 hidden text-xs text-muted-foreground sm:inline">different component products</span>
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>
      </section>

      <section className="space-y-5 border-b pb-6">
        <SectionHeading number={2} title="Output" detail="Select the SKU produced by one build, or create it without leaving this recipe." />
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_180px] md:pl-10">
          <div><Label>Output variant *</Label><BuildVariantSelector value={outputVariant} onChange={setOutputVariant} label="Search output SKU" /></div>
          <div><Label>Output units per build *</Label><Input type="number" min="1" step="1" value={outputQty} onChange={(event) => setOutputQty(event.target.value)} /></div>
        </div>
      </section>

      <section className="space-y-5 border-b pb-6">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
          <SectionHeading number={3} title="Bill of materials" detail="Enter the exact component quantities consumed by one build." />
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setComponents((current) => [...current, { key: nextComponentKey, variant: null, qtyPerBuild: "1" }]);
              setNextComponentKey((current) => current + 1);
            }}
          >
            <Plus className="mr-2 h-4 w-4" />Component
          </Button>
        </div>
        <div className="space-y-4 md:pl-10">
          {components.map((component, index) => (
            <div key={component.key} className="grid gap-3 border-l-4 border-muted bg-muted/20 p-4 md:grid-cols-[minmax(0,1fr)_140px_40px]">
              <div>
                <Label>Component {index + 1} *</Label>
                <BuildVariantSelector
                  value={component.variant}
                  onChange={(variant) => setComponents((current) => current.map((item) => item.key === component.key ? { ...item, variant } : item))}
                  label="Search component SKU"
                />
              </div>
              <div><Label>Qty per build *</Label><Input type="number" min="1" step="1" value={component.qtyPerBuild} onChange={(event) => setComponents((current) => current.map((item) => item.key === component.key ? { ...item, qtyPerBuild: event.target.value } : item))} /></div>
              <Button type="button" variant="ghost" size="icon" className="mt-5" disabled={components.length === 1} onClick={() => setComponents((current) => current.filter((item) => item.key !== component.key))} title={`Remove component ${index + 1}`}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-5 border-b pb-6">
        <SectionHeading number={4} title="Validation and activation" detail="Review the transformation before making it available to build orders." />
        <div className="space-y-4 md:pl-10">
          {evidence ? (
            <div className={evidence.valid
              ? "flex items-start gap-3 border border-green-300 bg-green-50 p-4 text-green-950"
              : "flex items-start gap-3 border border-red-300 bg-red-50 p-4 text-red-950"}
            >
              {evidence.valid ? <Check className="mt-0.5 h-5 w-5 shrink-0" /> : <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />}
              <div>
                <div className="font-medium">{evidence.message}</div>
                <div className="text-sm">{evidence.inputBaseUnits.toString()} input / {evidence.outputBaseUnits.toString()} output base units</div>
              </div>
            </div>
          ) : (
            <div className="border bg-muted/20 p-4 text-sm text-muted-foreground">Select an output and complete every component row to validate this recipe.</div>
          )}
          <div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
            <div>
              <Label>Status</Label>
              <Select value={status} onValueChange={(value) => { if (value === "active" || value === "draft") setStatus(value); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="active">Active</SelectItem><SelectItem value="draft">Draft</SelectItem></SelectContent>
              </Select>
              <div className="mt-2"><Badge variant={status === "active" ? "default" : "secondary"}>{status}</Badge></div>
            </div>
            <div><Label>Notes</Label><Textarea className="min-h-28" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Assembly instructions, tooling, or handling notes" /></div>
          </div>
        </div>
      </section>

      {isEditing && (
        <>
          <section className="space-y-5 border-b pb-6">
            <SectionHeading number={5} title="Change record" detail="Explain why this recipe is changing. The reason and before/after definition are written to the immutable audit log." />
            <div className="space-y-2 md:pl-10">
              <Label htmlFor="change-reason">Reason for change *</Label>
              <Textarea
                id="change-reason"
                className="min-h-24"
                maxLength={1000}
                value={changeReason}
                onChange={(event) => setChangeReason(event.target.value)}
                placeholder="Describe the operational reason, source evidence, and expected effect."
              />
              <div className="text-xs text-muted-foreground">{changeReason.trim().length}/1000 characters</div>
            </div>
          </section>

          <section className="space-y-5 border-b pb-6">
            <SectionHeading number={6} title="Version history" detail="Every saved definition remains available for operational and audit traceability." />
            <div className="overflow-x-auto border md:ml-10">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left">
                  <tr>
                    <th className="px-3 py-2">Version</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Changed by</th>
                    <th className="px-3 py-2">Changed at</th>
                    <th className="px-3 py-2">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {versionHistory.map((version) => (
                    <tr key={version.id} className="border-b last:border-b-0">
                      <td className="px-3 py-2 font-medium">v{version.version}</td>
                      <td className="px-3 py-2"><Badge variant={version.status === "active" ? "default" : "secondary"}>{version.status}</Badge></td>
                      <td className="px-3 py-2">{version.createdBy ?? "-"}</td>
                      <td className="whitespace-nowrap px-3 py-2">{new Date(version.createdAt).toLocaleString()}</td>
                      <td className="max-w-md px-3 py-2">{version.changeReason ?? (version.version === 1 ? "Initial recipe definition" : "-")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      <footer className="flex justify-end gap-2 pb-8">
        <Button variant="outline" onClick={() => navigate("/inventory/builds?tab=recipes")}>Cancel</Button>
        <Button disabled={!valid || saveRecipe.isPending} onClick={() => saveRecipe.mutate()}>
          {saveRecipe.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{isEditing ? "Save new version" : "Create recipe"}
        </Button>
      </footer>
    </div>
  );
}
