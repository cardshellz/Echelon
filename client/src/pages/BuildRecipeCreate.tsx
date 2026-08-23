import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, ArrowLeftRight, Check, Hammer, Loader2, Plus, X } from "lucide-react";
import { useLocation } from "wouter";
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
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState("active");
  const [recipeType, setRecipeType] = useState<RecipeType>("assembly");
  const [outputVariant, setOutputVariant] = useState<BuildVariantResult | null>(null);
  const [outputQty, setOutputQty] = useState("1");
  const [nextComponentKey, setNextComponentKey] = useState(2);
  const [components, setComponents] = useState<RecipeComponentDraft[]>([
    { key: 1, variant: null, qtyPerBuild: "1" },
  ]);

  const evidence = useMemo(() => calculateRecipeEvidence({
    recipeType,
    outputVariant,
    outputQty,
    components,
  }), [components, outputQty, outputVariant, recipeType]);
  const valid = Boolean(code.trim() && name.trim() && evidence?.valid);

  const createRecipe = useMutation({
    mutationFn: async () => responseJson(await fetch("/api/inventory/build-recipes", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: code.trim(),
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
      }),
    })),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/inventory/build-recipes"] });
      toast({ title: "Build recipe created" });
      navigate("/inventory/builds?tab=recipes");
    },
    onError: (error: Error) => toast({
      title: "Recipe creation failed",
      description: error.message,
      variant: "destructive",
    }),
  });

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-3 md:p-6">
      <header className="flex flex-col justify-between gap-4 border-b pb-5 sm:flex-row sm:items-start">
        <div>
          <Button variant="ghost" className="mb-2 px-0" onClick={() => navigate("/inventory/builds?tab=recipes")}>
            <ArrowLeft className="mr-2 h-4 w-4" />Back to Builds
          </Button>
          <h1 className="text-2xl font-bold">Create build recipe</h1>
          <p className="text-sm text-muted-foreground">Define a versioned, repeatable transformation from component inventory into an output SKU.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => navigate("/inventory/builds?tab=recipes")}>Cancel</Button>
          <Button disabled={!valid || createRecipe.isPending} onClick={() => createRecipe.mutate()}>
            {createRecipe.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Create recipe
          </Button>
        </div>
      </header>

      <section className="space-y-5 border-b pb-6">
        <SectionHeading number={1} title="Recipe identity" detail="Name the operational rule and choose how it should be classified." />
        <div className="grid gap-4 pl-0 md:grid-cols-2 md:pl-10">
          <div><Label>Recipe code *</Label><Input value={code} onChange={(event) => setCode(event.target.value)} placeholder="QUAD-BOX-TOP-EA" /></div>
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
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="active">Active</SelectItem><SelectItem value="draft">Draft</SelectItem></SelectContent>
              </Select>
              <div className="mt-2"><Badge variant={status === "active" ? "default" : "secondary"}>{status}</Badge></div>
            </div>
            <div><Label>Notes</Label><Textarea className="min-h-28" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Assembly instructions, tooling, or handling notes" /></div>
          </div>
        </div>
      </section>

      <footer className="flex justify-end gap-2 pb-8">
        <Button variant="outline" onClick={() => navigate("/inventory/builds?tab=recipes")}>Cancel</Button>
        <Button disabled={!valid || createRecipe.isPending} onClick={() => createRecipe.mutate()}>
          {createRecipe.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Create recipe
        </Button>
      </footer>
    </div>
  );
}
