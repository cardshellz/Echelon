import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, ExternalLink, Loader2, Plus, Search } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { shopifyProductFetch, ShopifyProductRequestError } from "@/lib/shopify-product-connection";
import {
  formatShopifyConnectionMoney, parseShopifyConnectionMoney, type ShopifyConnectionContext,
  type ShopifyConnectionPreview, type ShopifyProductConnectionCommand, type ShopifyProductConnectionExecute,
  type ShopifyProductConnectionRequest,
  shopifyProductConnectionContextSchema, shopifyProductConnectionCommandSchema,
  shopifyProductConnectionPreviewSchema, shopifyProductConnectionResultSchema,
} from "@shared/catalog/shopify-product-connection";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const ROWS_PER_PAGE = 25;

function VariantChoice(props: {
  value: string | null; sku: string | null;
  candidates: ShopifyConnectionPreview["remoteVariants"];
  onChange: (id: string) => void; disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const selected = props.candidates.find(candidate => candidate.id === props.value);
  const query = search.trim().toLowerCase();
  const choices = props.candidates.filter(candidate => !query || `${candidate.sku || ""} ${candidate.title} ${candidate.id}`.toLowerCase().includes(query));
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <Button variant="outline" size="sm" className="max-w-full justify-start text-left" disabled={props.disabled}
        aria-label={`Select Shopify variant for ${props.sku || "catalog item"}`}>
        <Search className="mr-2 h-3 w-3 shrink-0" />
        <span className="truncate">{selected ? `${selected.sku || selected.title} · ${selected.id}` : "Select Shopify variant"}</span>
      </Button>
    </PopoverTrigger>
    <PopoverContent className="w-96 max-w-[90vw] p-2" align="start">
      <Input aria-label="Search Shopify variants" placeholder="Search SKU, name or ID" value={search} onChange={event => setSearch(event.target.value)} />
      {open && <div className="mt-2 max-h-64 overflow-auto">
        {choices.slice(0,50).map(candidate => <button type="button" key={candidate.id} className="block w-full rounded p-2 text-left text-sm hover:bg-muted"
          onClick={() => { props.onChange(candidate.id); setOpen(false); }}>
          <span className="block font-mono text-xs">{candidate.sku || "No SKU"} · {candidate.id}</span>
          <span>{candidate.title}</span>
        </button>)}
        {choices.length > 50 && <p className="p-2 text-xs text-muted-foreground">Refine the search to see more matches.</p>}
        {!choices.length && <p className="p-2 text-sm text-muted-foreground">No matching variants.</p>}
      </div>}
    </PopoverContent>
  </Popover>;
}

export function ShopifyProductConnectionActions({ productId }: { productId: number }) {
  const { hasPermission } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const allowed = hasPermission("inventory", "edit") && hasPermission("channels", "edit");
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"create" | "link">("link");
  const [channelId, setChannelId] = useState<number | undefined>();
  const [target, setTarget] = useState("");
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [comparisons, setComparisons] = useState<Record<string, string>>({});
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const [publicationId, setPublicationId] = useState<string | null>(null);
  const [requiresShipping, setRequiresShipping] = useState(true);
  const [review, setReview] = useState<ShopifyConnectionPreview | null>(null);
  const [reviewRequest, setReviewRequest] = useState<ShopifyProductConnectionRequest | null>(null);
  const [dirty, setDirty] = useState(true);
  const [submitted, setSubmitted] = useState<ShopifyProductConnectionExecute | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const initialized = useRef<number | null>(null);
  const handledTerminal = useRef<string | null>(null);
  const base = `/api/products/${productId}/shopify-connection`;
  const contextUrl = `${base}${channelId ? `?channelId=${channelId}` : ""}`;
  const contextQuery = useQuery<ShopifyConnectionContext>({ queryKey: [contextUrl],
    queryFn: () => shopifyProductFetch(contextUrl, undefined, shopifyProductConnectionContextSchema), enabled: open && allowed, retry: false, staleTime: 15_000 });
  const context = contextQuery.data;

  useEffect(() => {
    if (open && context?.pendingCommand && submitted === null
      && context.pendingCommand.commandKey !== handledTerminal.current) {
      const pending = context.pendingCommand;
      setSubmitted({ commandKey: pending.commandKey, request: pending.request, previewHash: pending.previewHash });
    }
  }, [open, context?.pendingCommand, submitted]);

  useEffect(() => {
    if (!open || !context || initialized.current === context.channelId) return;
    initialized.current = context.channelId;
    setPrices(Object.fromEntries(context.variants.map(variant => [String(variant.id), variant.priceCents === null ? "" : formatShopifyConnectionMoney(variant.priceCents)])));
    setComparisons(Object.fromEntries(context.variants.map(variant => [String(variant.id), variant.compareAtPriceCents === null ? "" : formatShopifyConnectionMoney(variant.compareAtPriceCents)])));
    setTarget(mode === "link" ? context.matchingProducts[0]?.id || "" : "");
    setBindings({}); setPublicationId(null); setRequiresShipping(true); setReview(null); setReviewRequest(null); setDirty(true); setPage(0);
  }, [context, open, mode]);

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: [contextUrl] }),
      queryClient.invalidateQueries({ queryKey: [`/api/products/${productId}/shopify-mapping`] }),
      queryClient.invalidateQueries({ queryKey: [`/api/products/${productId}`] }),
      queryClient.invalidateQueries({ queryKey: [`/api/products/${productId}/channel-listings`] }),
      queryClient.invalidateQueries({ queryKey: ["/api/product-variants"] }),
      queryClient.invalidateQueries({ queryKey: ["/api/products"] }),
    ]);
  };

  const request = (): ShopifyProductConnectionRequest => {
    if (!context) throw new Error("The Shopify product context has not loaded.");
    const ids = context.productOnly ? [null] : context.variants.map(variant => variant.id);
    return { channelId: context.channelId, currency: context.currency, mode,
      targetProductRef: mode === "link" ? target.trim() : undefined,
      productOnlyRequiresShipping: requiresShipping,
      publicationId: mode === "create" ? publicationId : null,
      bindings: mode === "link" ? Object.entries(bindings).map(([variantId, remoteVariantId]) => ({ variantId: Number(variantId), remoteVariantId })) : [],
      prices: mode === "create" ? ids.map(variantId => {
        const key = variantId === null ? "product" : String(variantId);
        const priceCents = parseShopifyConnectionMoney(prices[key] || "");
        const compareText = comparisons[key]?.trim();
        const compareAtPriceCents = compareText ? parseShopifyConnectionMoney(compareText) : null;
        if (priceCents === null || compareText && compareAtPriceCents === null) throw new Error("Enter valid prices with at most two decimal places for every selected item.");
        return { variantId, priceCents, compareAtPriceCents };
      }) : [],
    };
  };

  const reviewMutation = useMutation({
    mutationFn: async () => { const reviewedRequest = request(); return {
      request: reviewedRequest, preview: await shopifyProductFetch(`${base}/preview`, reviewedRequest, shopifyProductConnectionPreviewSchema),
    }; },
    onMutate: () => setError(null),
    onSuccess: result => { setReview(result.preview); setReviewRequest(result.request); setDirty(false); setSubmitted(null); },
    onError: failure => setError(failure instanceof Error ? failure.message : "The Shopify product could not be reviewed."),
  });

  const executeMutation = useMutation({
    mutationFn: (intent: ShopifyProductConnectionExecute) => shopifyProductFetch(`${base}/execute`, intent, shopifyProductConnectionResultSchema),
    onMutate: () => setError(null),
    onSuccess: async (result, intent) => {
      if (result.command.state === "complete") await finish(result.command);
      else { setSubmitted(intent); await queryClient.invalidateQueries({ queryKey: [contextUrl] }); }
    },
    onError: async (failure, intent) => {
      setError(failure instanceof Error ? failure.message : "The Shopify command needs review.");
      await queryClient.invalidateQueries({ queryKey: [contextUrl] });
      try {
        const command = await shopifyProductFetch(`${base}/commands/${intent.commandKey}`, undefined, shopifyProductConnectionCommandSchema);
        if (command.state === "rejected") { handledTerminal.current = command.commandKey; setSubmitted(null); setDirty(true); }
      } catch (statusError) {
        if (statusError instanceof ShopifyProductRequestError && statusError.code === "SHOPIFY_COMMAND_NOT_FOUND"
          && failure instanceof ShopifyProductRequestError && !failure.retryable) {
          setSubmitted(null); setDirty(true);
        }
        // An unreadable outcome retains the original intent for exact retry.
      }
    },
  });

  const statusQuery = useQuery<ShopifyProductConnectionCommand>({
    queryKey: [`${base}/commands/${submitted?.commandKey || "none"}`],
    queryFn: () => shopifyProductFetch(`${base}/commands/${submitted!.commandKey}`, undefined, shopifyProductConnectionCommandSchema),
    enabled: open && submitted !== null, retry: false,
    refetchInterval: query => query.state.data && ["complete", "rejected"].includes(query.state.data.state) ? false : 1_500,
  });
  async function finish(command: ShopifyProductConnectionCommand) {
    if (handledTerminal.current === command.commandKey) return;
    handledTerminal.current = command.commandKey;
    await invalidate(); setSubmitted(null); setReview(null); setError(null); setOpen(false);
    toast({ title: command.mode === "create" ? "Shopify product created and connected" : "Shopify product linked",
      description: command.remoteProductId ? `Shopify product ${command.remoteProductId}` : undefined });
  }
  useEffect(() => {
    const command = statusQuery.data;
    if (!command || handledTerminal.current === command.commandKey) return;
    if (command.state === "complete") void finish(command);
    else if (command.state === "rejected") {
      handledTerminal.current = command.commandKey;
      setError(command.lastErrorMessage || "Shopify rejected this request. Review a new request.");
      setSubmitted(null); setDirty(true); void queryClient.invalidateQueries({ queryKey: [contextUrl] });
    }
  }, [statusQuery.data]);

  const pending = statusQuery.data && !["complete", "rejected"].includes(statusQuery.data.state) ? statusQuery.data : context?.pendingCommand;
  const busy = contextQuery.isFetching || reviewMutation.isPending || executeMutation.isPending;
  const locked = Boolean(pending || submitted || executeMutation.isPending);
  const change = () => { setDirty(true); setError(null); };
  const start = (nextMode: "create" | "link") => {
    initialized.current = null; setMode(nextMode); setChannelId(undefined); setTarget(""); setReview(null); setReviewRequest(null);
    setSubmitted(null); setError(null); setPage(0); setOpen(true);
  };
  const resume = () => {
    const intent = pending ? { commandKey: pending.commandKey, request: pending.request, previewHash: pending.previewHash } : submitted;
    if (intent) { setSubmitted(intent); executeMutation.mutate(intent); }
  };
  const confirm = () => {
    if (!review || !review.ready || dirty || !reviewRequest) return;
    const intent: ShopifyProductConnectionExecute = { request: reviewRequest, previewHash: review.previewHash, commandKey: crypto.randomUUID() };
    setSubmitted(intent); executeMutation.mutate(intent);
  };
  const rowSource = review?.variants ?? (context?.productOnly ? [{ variantId: null, sku: context.productSku, name: "Product", remoteVariantId: null, priceCents: null }]
    : context?.variants.map(variant => ({ variantId: variant.id, sku: variant.sku, name: variant.name, remoteVariantId: null, priceCents: variant.priceCents })) ?? []);
  const rows = rowSource.slice(page * ROWS_PER_PAGE, (page + 1) * ROWS_PER_PAGE);

  return <>
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={() => start("link")} disabled={!allowed || executeMutation.isPending}>
        <ArrowRightLeft className="mr-2 h-4 w-4" />Link existing Shopify product
      </Button>
      <Button size="sm" onClick={() => start("create")} disabled={!allowed || executeMutation.isPending}>
        <Plus className="mr-2 h-4 w-4" />Create on Shopify
      </Button>
    </div>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "Create Shopify product" : "Link existing Shopify product"}</DialogTitle>
          <DialogDescription>Review and connect this catalog product only. No store-wide sync is required.</DialogDescription>
        </DialogHeader>
        {contextQuery.isLoading && <p className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Checking the Shopify connection…</p>}
        {contextQuery.isError && <div role="alert" className="space-y-2 text-sm text-destructive">
          <p>{contextQuery.error instanceof Error ? contextQuery.error.message : "The Shopify connection could not be loaded."}</p>
          <Button variant="outline" onClick={() => contextQuery.refetch()}>Retry connection check</Button>
        </div>}
        {context && <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1"><Label>Shopify channel</Label>
              <Select value={String(context.channelId)} disabled={locked} onValueChange={value => { setChannelId(Number(value)); initialized.current = null; setSubmitted(null); change(); }}>
                <SelectTrigger aria-label="Shopify channel"><SelectValue /></SelectTrigger>
                <SelectContent>{context.channels.map(channel => <SelectItem key={channel.id} value={String(channel.id)}>{channel.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="text-sm"><p className="font-medium">{context.productName}</p><p className="font-mono text-xs text-muted-foreground">{context.productSku}</p>
              <p className="mt-1 text-xs text-muted-foreground">{context.shopDomain} · {context.currency}</p></div>
          </div>
          {pending && <div className="space-y-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm" role="status">
            <p className="font-medium">This product has a saved Shopify command to finish.</p>
            <p>{pending.lastErrorMessage || "The saved command is running in the background. You can close this window and check it later."}</p>
            {pending.remoteProductId && <a className="inline-flex items-center gap-1 underline" target="_blank" rel="noopener noreferrer" href={`https://${context.shopDomain}/admin/products/${pending.remoteProductId}`}>
              View Shopify product <ExternalLink className="h-3 w-3" /></a>}
          </div>}
          {context.blockedReason && <p role="alert" className="text-sm text-destructive">{context.blockedReason}</p>}
          {!pending && context.matchingProducts.length > 0 && <div className="space-y-2 rounded border p-3 text-sm">
            <p className="font-medium">Shopify products matching this catalog's SKUs</p>
            {context.matchingProducts.map(product => <div key={product.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>{product.title} · {product.status.toLowerCase()} · {product.id}</span>
              <Button size="sm" variant="outline" disabled={locked} onClick={() => { setMode("link"); setTarget(product.id); setReview(null); setBindings({}); change(); }}>Link this product</Button>
            </div>)}
          </div>}
          {context.lookupIssue && <p className="text-sm text-muted-foreground">SKU lookup: {context.lookupIssue} You can still enter an exact Shopify product ID.</p>}
          {mode === "link" ? <div className="space-y-1"><Label htmlFor="shopify-product-reference">Shopify product URL or ID</Label>
            <Input id="shopify-product-reference" value={target} disabled={locked} placeholder="Paste the Shopify admin product URL or product ID"
              onChange={event => { setTarget(event.target.value); setReview(null); setBindings({}); change(); }} /></div>
            : <div className="space-y-3">
              <div className="space-y-1"><Label>Shopify visibility</Label>
                <Select value={publicationId ?? "draft"} disabled={locked} onValueChange={value => { setPublicationId(value === "draft" ? null : value); change(); }}>
                  <SelectTrigger aria-label="Shopify visibility"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="draft">Create as unpublished draft</SelectItem>
                    {context.publications.map(publication => <SelectItem key={publication.id} value={publication.id}>Create and publish to {publication.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                {context.publicationIssue && <p className="text-xs text-muted-foreground">{context.publicationIssue}</p>}
              </div>
              {context.productOnly && <label className="flex items-center gap-2 text-sm"><Checkbox checked={requiresShipping} disabled={locked}
                onCheckedChange={value => { setRequiresShipping(value === true); change(); }} />This product requires shipping</label>}
            </div>}
          <div className="space-y-3 rounded border p-3">
            <p className="text-sm font-medium">{context.productOnly ? "Product identity" : "Active customer-sellable variants"}</p>
            {rows.map(row => {
              const key = row.variantId === null ? "product" : String(row.variantId);
              return <div key={key} className="grid items-center gap-2 border-t pt-3 first:border-0 first:pt-0 sm:grid-cols-2">
                <div><p className="text-sm font-medium">{row.name}</p><p className="font-mono text-xs text-muted-foreground">{row.sku || "No SKU"}</p></div>
                {mode === "create" ? <div className="grid grid-cols-2 gap-2">
                  <div><Label className="text-xs" htmlFor={`shopify-price-${key}`}>Price ({context.currency})</Label><Input id={`shopify-price-${key}`} inputMode="decimal" value={prices[key] || ""} disabled={locked}
                    onChange={event => { setPrices(current => ({ ...current, [key]: event.target.value })); change(); }} /></div>
                  <div><Label className="text-xs" htmlFor={`shopify-compare-${key}`}>Compare-at (optional)</Label><Input id={`shopify-compare-${key}`} inputMode="decimal" value={comparisons[key] || ""} disabled={locked}
                    onChange={event => { setComparisons(current => ({ ...current, [key]: event.target.value })); change(); }} /></div>
                </div> : review && row.variantId !== null ? <VariantChoice value={bindings[key] || row.remoteVariantId} sku={row.sku}
                  candidates={review.remoteVariants} disabled={locked} onChange={id => { setBindings(current => ({ ...current, [key]: id })); change(); }} />
                  : <p className="text-xs text-muted-foreground">Review the product to verify its Shopify identity.</p>}
              </div>;
            })}
            {rowSource.length > ROWS_PER_PAGE && <div className="flex items-center justify-between text-xs">
              <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(current => current - 1)}>Previous variants</Button>
              <span>{page * ROWS_PER_PAGE + 1}–{Math.min((page + 1) * ROWS_PER_PAGE, rowSource.length)} of {rowSource.length}</span>
              <Button variant="outline" size="sm" disabled={(page + 1) * ROWS_PER_PAGE >= rowSource.length} onClick={() => setPage(current => current + 1)}>Next variants</Button>
            </div>}
          </div>
          {review && <div className="space-y-2 rounded border bg-muted/30 p-3 text-sm" role="status">
            <p className="font-medium">{review.targetTitle}{review.targetProductId ? ` · ${review.targetProductId}` : ""}</p>
            {review.warnings.map(warning => <p key={warning}>{warning}</p>)}
            {review.issues.map(issue => <p key={issue} className="text-destructive">{issue}</p>)}
            {dirty && <p className="font-medium">Changes need a fresh review.</p>}
          </div>}
        </div>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter className="flex-wrap gap-2">
          <Button variant="outline" onClick={() => setOpen(false)}>Close</Button>
          {pending || submitted ? <Button onClick={resume} disabled={busy}>
            {executeMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Resume saved Shopify command
          </Button> : <>
            <Button variant="outline" onClick={() => reviewMutation.mutate()} disabled={!context || busy || Boolean(context.blockedReason) || mode === "link" && !target.trim()}>
              {reviewMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{review ? "Refresh review" : "Review Shopify connection"}
            </Button>
            <Button onClick={confirm} disabled={!review?.ready || dirty || busy || Boolean(context?.blockedReason)}>
              {mode === "create" ? publicationId ? "Create, connect and publish" : "Create draft and connect" : "Confirm Shopify link"}
            </Button>
          </>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
