import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Image as ImageIcon, MapPin } from "lucide-react";
import type {
  ProductCategory,
  ProductContentFormState,
  ProductDetailData,
  ProductLocationAssignment,
  ShippingGroup,
} from "./product-detail-types-and-helpers";

export function ProductContentSection({
  contentForm,
  updateContentField,
  activeProductCategories,
  activeShippingGroups,
}: {
  contentForm: ProductContentFormState;
  updateContentField: (field: string, value: string) => void;
  activeProductCategories: ProductCategory[];
  activeShippingGroups: ShippingGroup[];
}) {
  return (
    <>
      <Card>
        <CardHeader className="p-3 md:p-6">
          <CardTitle className="text-base md:text-lg">Product Content</CardTitle>
          <CardDescription className="text-xs md:text-sm">
            Marketing title, description, and metadata
          </CardDescription>
        </CardHeader>
        <CardContent className="p-3 md:p-6 pt-0 md:pt-0 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs md:text-sm">Title</Label>
              <Input
                value={contentForm.title}
                onChange={(e) => updateContentField("title", e.target.value)}
                placeholder="Marketing title for listings"
                className="h-9"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs md:text-sm">Status</Label>
              <Select
                value={contentForm.status}
                onValueChange={(v) => updateContentField("status", v)}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="archived">Archived</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs md:text-sm">Description</Label>
            <Textarea
              value={contentForm.description}
              onChange={(e) => updateContentField("description", e.target.value)}
              rows={4}
              className="resize-none"
              placeholder="Product description for listings"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs md:text-sm">Bullet Points</Label>
            <Textarea
              value={contentForm.bulletPoints}
              onChange={(e) => updateContentField("bulletPoints", e.target.value)}
              rows={4}
              className="resize-none"
              placeholder="One bullet point per line"
            />
            <p className="text-xs text-muted-foreground">One per line. Used in Amazon, eBay listings.</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="p-3 md:p-6">
          <CardTitle className="text-base md:text-lg">Classification</CardTitle>
        </CardHeader>
        <CardContent className="p-3 md:p-6 pt-0 md:pt-0 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs md:text-sm">Category</Label>
              <Select
                value={contentForm.categoryId}
                onValueChange={(value) => updateContentField("categoryId", value)}
              >
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Select category" />
                </SelectTrigger>
                <SelectContent>
                  {activeProductCategories.map((category) => (
                    <SelectItem key={category.id} value={String(category.id)}>{category.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs md:text-sm">Subcategory</Label>
              <Input
                value={contentForm.subcategory}
                onChange={(e) => updateContentField("subcategory", e.target.value)}
                className="h-9"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs md:text-sm">Brand</Label>
              <Input
                value={contentForm.brand}
                onChange={(e) => updateContentField("brand", e.target.value)}
                className="h-9"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs md:text-sm">Manufacturer</Label>
              <Input
                value={contentForm.manufacturer}
                onChange={(e) => updateContentField("manufacturer", e.target.value)}
                className="h-9"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs md:text-sm">Tags</Label>
            <Input
              value={contentForm.tags}
              onChange={(e) => updateContentField("tags", e.target.value)}
              placeholder="Comma-separated tags"
              className="h-9"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="p-3 md:p-6">
          <CardTitle className="text-base md:text-lg">Fulfillment characteristics</CardTitle>
        </CardHeader>
        <CardContent className="p-3 md:p-6 pt-0 md:pt-0 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs md:text-sm">Shipping group</Label>
              <Select
                value={contentForm.shippingGroupId}
                onValueChange={(value) => updateContentField("shippingGroupId", value)}
              >
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Select shipping group" />
                </SelectTrigger>
                <SelectContent>
                  {activeShippingGroups.map((group) => (
                    <SelectItem key={group.id} value={String(group.id)}>{group.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Which items can ship together — governs packing and storefront free-shipping thresholds.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="p-3 md:p-6">
          <CardTitle className="text-base md:text-lg">SEO</CardTitle>
        </CardHeader>
        <CardContent className="p-3 md:p-6 pt-0 md:pt-0 space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs md:text-sm">SEO Title</Label>
            <Input
              value={contentForm.seoTitle}
              onChange={(e) => updateContentField("seoTitle", e.target.value)}
              placeholder="Page title for search engines"
              className="h-9"
            />
            <p className="text-xs text-muted-foreground">
              {contentForm.seoTitle.length}/70 characters
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs md:text-sm">SEO Description</Label>
            <Textarea
              value={contentForm.seoDescription}
              onChange={(e) => updateContentField("seoDescription", e.target.value)}
              rows={3}
              className="resize-none"
              placeholder="Meta description for search engines"
            />
            <p className="text-xs text-muted-foreground">
              {contentForm.seoDescription.length}/160 characters
            </p>
          </div>
        </CardContent>
      </Card>
    </>
  );
}

export function ProductDetailSidebar({
  product,
  productLocations,
  activeVariantCount,
}: {
  product: ProductDetailData;
  productLocations: ProductLocationAssignment[];
  activeVariantCount: number;
}) {
  const primaryAsset = product.assets?.find((a) => a.isPrimary === 1) || product.assets?.[0];

  return (
    <div className="space-y-4 order-1 lg:order-2">
      <Card>
        <CardHeader className="p-3 md:p-6">
          <CardTitle className="text-base md:text-lg">Product Image</CardTitle>
        </CardHeader>
        <CardContent className="p-3 md:p-6 pt-0 md:pt-0">
          <div className="aspect-square bg-muted rounded-lg flex items-center justify-center overflow-hidden">
            {primaryAsset ? (
              <img
                src={primaryAsset.storageType === "file" || primaryAsset.storageType === "both"
                  ? `/api/product-assets/${primaryAsset.id}/file`
                  : primaryAsset.url ?? undefined}
                alt={primaryAsset.altText || product.name}
                className="w-full h-full object-cover"
              />
            ) : (
              <ImageIcon className="h-12 w-12 md:h-16 md:w-16 text-muted-foreground/30" />
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="p-3 md:p-6">
          <CardTitle className="text-base md:text-lg flex items-center gap-2">
            <MapPin className="h-4 w-4" /> Pick Location
          </CardTitle>
        </CardHeader>
        <CardContent className="p-3 md:p-6 pt-0 md:pt-0">
          {productLocations.length > 0 ? (
            <div className="space-y-1">
              {productLocations.map((pl) => (
                <div key={pl.id} className="flex items-center gap-2 text-sm">
                  <span className="font-mono font-medium">{pl.location}</span>
                  {pl.sku && <span className="text-muted-foreground text-xs">({pl.sku})</span>}
                  {pl.isPrimary === 1 && <Badge variant="outline" className="text-[10px] px-1">Primary</Badge>}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No pick location assigned</p>
          )}
          <Link href="/slotting-setup" className="text-xs text-blue-600 hover:underline mt-2 inline-block">
            Manage in Slotting Setup
          </Link>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="p-3 md:p-6">
          <CardTitle className="text-base md:text-lg">Quick Stats</CardTitle>
        </CardHeader>
        <CardContent className="p-3 md:p-6 pt-0 md:pt-0 space-y-3">
          <div className="flex justify-between">
            <span className="text-xs md:text-sm text-muted-foreground">Variants</span>
            <span className="text-sm font-medium">{activeVariantCount}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-xs md:text-sm text-muted-foreground">Images</span>
            <span className="text-sm font-medium">{product.assets?.length || 0}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-xs md:text-sm text-muted-foreground">Lead Time</span>
            <span className="text-sm font-medium">{product.leadTimeDays}d</span>
          </div>
          <div className="flex justify-between">
            <span className="text-xs md:text-sm text-muted-foreground">Status</span>
            <Badge
              variant={product.isActive ? "default" : "secondary"}
              className="text-xs"
            >
              {product.isActive ? "Active" : "Inactive"}
            </Badge>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
