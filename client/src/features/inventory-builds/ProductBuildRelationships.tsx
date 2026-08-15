import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Boxes, ExternalLink, RefreshCw } from "lucide-react";
import { Link } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type BuildRecipeRelationship = {
  recipeId: number;
  code: string;
  name: string;
  version: number;
  status: string;
  quantityPerBuild: number;
  outputVariantId: number;
  outputSku: string | null;
  outputName: string;
  outputQty: number;
};

type ProductVariantBuildRelationships = {
  variantId: number;
  sku: string | null;
  name: string;
  isActive: boolean;
  producedBy: BuildRecipeRelationship[];
  usedIn: BuildRecipeRelationship[];
};

type ProductBuildRelationshipsProps = {
  productId: number;
  enabled: boolean;
};

function recipeStatusBadge(status: string) {
  const className = status === "active"
    ? "border-green-300 bg-green-50 text-green-700"
    : "border-slate-300 bg-slate-50 text-slate-600";

  return (
    <Badge variant="outline" className={className}>
      {status}
    </Badge>
  );
}

function recipeLabel(recipe: BuildRecipeRelationship): string {
  return `${recipe.code} v${recipe.version}`;
}

function relationshipRole(variant: ProductVariantBuildRelationships): string {
  if (variant.producedBy.length > 0 && variant.usedIn.length > 0) return "Output + component";
  if (variant.producedBy.length > 0) return "Build output";
  if (variant.usedIn.length > 0) return "Build component";
  return "No build recipe";
}

function RelationshipList({
  label,
  recipes,
  relationship,
}: {
  label: string;
  recipes: BuildRecipeRelationship[];
  relationship: "output" | "component";
}) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-xs font-medium text-muted-foreground">{label}</p>
      {recipes.length === 0 ? (
        <span className="text-sm text-muted-foreground">None</span>
      ) : (
        <div className="space-y-2">
          {recipes.map((recipe) => (
            <div key={`${relationship}-${recipe.recipeId}`} className="rounded border px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs font-medium">{recipeLabel(recipe)}</span>
                {recipeStatusBadge(recipe.status)}
              </div>
              <p className="mt-1 text-sm">{recipe.name}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {relationship === "output"
                  ? `Produces ${recipe.quantityPerBuild} unit${recipe.quantityPerBuild === 1 ? "" : "s"} per build`
                  : `Consumes ${recipe.quantityPerBuild} unit${recipe.quantityPerBuild === 1 ? "" : "s"} per build to produce ${recipe.outputSku ?? recipe.outputName}`}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ProductBuildRelationships({ productId, enabled }: ProductBuildRelationshipsProps) {
  const endpoint = `/api/inventory/build-relationships/products/${productId}`;
  const relationshipsQuery = useQuery<ProductVariantBuildRelationships[]>({
    queryKey: [endpoint],
    enabled: enabled && Number.isSafeInteger(productId) && productId > 0,
  });
  const relationships = relationshipsQuery.data ?? [];
  const linkedVariantCount = relationships.filter(
    (variant) => variant.producedBy.length > 0 || variant.usedIn.length > 0,
  ).length;

  return (
    <Card>
      <CardHeader className="p-3 md:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base md:text-lg">
              <Boxes className="h-4 w-4" />
              Build Relationships
            </CardTitle>
            <CardDescription className="mt-1 text-xs md:text-sm">
              Recipe ownership for this product&apos;s variants.
            </CardDescription>
          </div>
          <Button asChild size="sm" variant="outline">
            <Link href="/inventory/builds?tab=recipes">
              Open Builds
              <ExternalLink className="ml-2 h-3.5 w-3.5" />
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-3 pt-0 md:p-6 md:pt-0">
        {relationshipsQuery.isLoading ? (
          <div className="flex min-h-24 items-center justify-center text-sm text-muted-foreground">
            <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
            Loading build relationships...
          </div>
        ) : relationshipsQuery.isError ? (
          <div className="flex min-h-24 flex-col items-center justify-center gap-3 border border-red-200 bg-red-50 p-4 text-center">
            <div className="flex items-center gap-2 text-sm font-medium text-red-700">
              <AlertCircle className="h-4 w-4" />
              Build relationships could not be loaded.
            </div>
            <Button size="sm" variant="outline" onClick={() => relationshipsQuery.refetch()}>
              <RefreshCw className="mr-2 h-3.5 w-3.5" />
              Retry
            </Button>
          </div>
        ) : relationships.length === 0 ? (
          <div className="min-h-24 border border-dashed p-4 text-sm text-muted-foreground">
            No variants are defined for this product.
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">{linkedVariantCount} linked</Badge>
              <span>{relationships.length} total variants</span>
            </div>
            {relationships.map((variant) => (
              <div key={variant.variantId} className="border p-3">
                <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="break-words font-mono text-sm font-medium">{variant.sku ?? variant.name}</p>
                    {variant.sku && <p className="mt-1 text-xs text-muted-foreground">{variant.name}</p>}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{relationshipRole(variant)}</Badge>
                    {!variant.isActive && <Badge variant="secondary">Archived</Badge>}
                  </div>
                </div>
                <div className="grid gap-3 lg:grid-cols-2">
                  <RelationshipList label="Produced by" recipes={variant.producedBy} relationship="output" />
                  <RelationshipList label="Used in" recipes={variant.usedIn} relationship="component" />
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
