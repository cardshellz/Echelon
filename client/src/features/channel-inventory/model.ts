import type {
  ChannelExposurePolicyHead,
  ChannelExposurePolicyScope,
  ChannelExposurePolicyValue,
  InventoryChannelExposureAdminView,
  InventoryChannelExposurePreview,
  PublicationSourceBindingHead,
  PublicationVariantMappingHead,
} from "@shared/types/inventory-channel-exposure";

import { bpsToPercentText, formatPercent, formatUnits, parseWholeUnits, percentTextToBps } from "./format";

/**
 * Pure view-model for the Channel Inventory workspace.
 *
 * Everything here is a deterministic function of server evidence. Nothing in
 * this module computes availability or a channel quantity: the server's
 * preview rows are the only source of proposed quantities. The one "resolver"
 * below (`resolveSavedFields`) only reports which *saved* rule supplies each
 * field for display next to an "Inherit" choice; it mirrors the server's
 * documented order (SKU → product → channel, draft preferred) and is never
 * used to calculate a number.
 */

export type View = InventoryChannelExposureAdminView;
export type Channel = View["channels"][number];
export type ChannelConnection = Channel["connections"][number];
export type DropshipStore = View["dropshipStores"][number];
export type Target = View["publicationTargets"][number];
export type FulfillmentNode = View["fulfillmentNodes"][number];
export type ProductSummary = View["products"][number];
export type Variant = NonNullable<View["selectedProduct"]>["variants"][number];
export type PolicySubject = View["policySubjects"][number];
export type PreviewRow = InventoryChannelExposurePreview["rows"][number];
export type Preview = InventoryChannelExposurePreview;
export type DefinitionAuthority = "draft" | "active";

// ---------------------------------------------------------------------------
// Providers and destination identity
// ---------------------------------------------------------------------------

/** Publishing adapters that exist in the inspected composition, by provider key. */
export const PUBLISHING_ADAPTERS = {
  shopify: { scopeType: "location", scopeNoun: "Shopify location" },
  ebay: { scopeType: "account", scopeNoun: "eBay seller account" },
  walmart: { scopeType: "location", scopeNoun: "Walmart fulfillment center" },
} as const;

export type SupportedProvider = keyof typeof PUBLISHING_ADAPTERS;

export function isSupportedProvider(provider: string): provider is SupportedProvider {
  return provider in PUBLISHING_ADAPTERS;
}

export const PROVIDER_LABELS: Record<string, string> = {
  shopify: "Shopify",
  ebay: "eBay",
  walmart: "Walmart US",
  tiktok: "TikTok",
  amazon: "Amazon",
  instagram: "Instagram",
  bigcommerce: "BigCommerce",
  dropship: "Dropship",
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider.replace(/_/g, " ");
}

/**
 * Operator-facing label for a dropship vendor store.
 *
 * The vendor trading name is optional in the catalog, so the label falls back
 * through identifiers that are always present instead of rendering a blank or
 * a fabricated name. The store id is the last resort because it is the only
 * value guaranteed to exist and to be unique.
 */
export function describeDropshipStore(store: DropshipStore): string {
  const account = store.externalAccountLabel ?? `store #${store.id}`;
  return store.vendorName ? `${store.vendorName} · ${account}` : account;
}

export type PublisherKey = Target["publicationAuthority"];

export const PUBLISHER_LABELS: Record<PublisherKey, { label: string; description: string }> = {
  echelon: {
    label: "Echelon publishes",
    description: "Echelon sends the calculated quantity to this destination when it is live.",
  },
  external_provider: {
    label: "Externally managed",
    description: "Another system (for example a 3PL integration) controls the quantity shown here. "
      + "Echelon calculates and records, but never writes.",
  },
  manual: {
    label: "Manual",
    description: "Quantities are maintained by hand at the provider. Echelon calculates and records, "
      + "but never writes.",
  },
};

export interface DestinationIdentity {
  id: number;
  /** Who receives quantities: store domain, seller account, or dropship store. */
  title: string;
  /** Exact scope inside that account: Shopify location or account id. */
  scope: string;
  provider: string;
  kind: Target["destinationKind"];
}

export function describeDestination(target: Target, view: View): DestinationIdentity {
  if (target.destinationKind === "channel_connection") {
    const channel = view.channels.find((item) => item.id === target.channelId) ?? null;
    const connection = channel?.connections.find((item) => item.id === target.channelConnectionId) ?? null;
    const provider = channel?.provider ?? "unknown";
    const account = connection?.providerAccount;
    const title = account?.displayName
      ?? connection?.externalAccountLabel
      ?? `Connection #${target.channelConnectionId}`;
    return {
      id: target.id,
      title,
      scope: describeScope(target, provider),
      provider,
      kind: target.destinationKind,
    };
  }
  const store = view.dropshipStores.find((item) => item.id === target.dropshipStoreConnectionId) ?? null;
  const provider = store?.platform ?? "unknown";
  return {
    id: target.id,
    title: store
      ? describeDropshipStore(store)
      : `Dropship store #${target.dropshipStoreConnectionId}`,
    scope: describeScope(target, provider),
    provider,
    kind: target.destinationKind,
  };
}

function describeScope(target: Target, provider: string): string {
  if (target.providerScopeType === "location") {
    return `${provider === "shopify" ? "Shopify location" : "Location"} ${target.externalScopeId}`;
  }
  return `${providerLabel(provider)} account ${target.externalScopeId}`;
}

// ---------------------------------------------------------------------------
// Publishing state
// ---------------------------------------------------------------------------

export type StateTone = "live" | "held" | "preview" | "off" | "external";

export interface PublishingStatus {
  label: string;
  tone: StateTone;
  explanation: string;
}

/**
 * Operator-facing reading of a destination's publication state. The runtime
 * only publishes Echelon-owned targets (publicationAuthority "echelon"); any
 * other publisher means Echelon never writes, whatever the state column says.
 */
export function describePublishing(target: Target): PublishingStatus {
  if (target.publicationAuthority !== "echelon") {
    return {
      label: PUBLISHER_LABELS[target.publicationAuthority].label,
      tone: "external",
      explanation: PUBLISHER_LABELS[target.publicationAuthority].description,
    };
  }
  if (target.state === "live" && target.hold) {
    return {
      label: "Held at zero",
      tone: "held",
      explanation: "Echelon keeps publishing to this destination, but every quantity it sends is zero "
        + `until the hold is released. Held ${formatHeldAt(target.hold.heldAt)} by ${target.hold.heldBy}: `
        + `${target.hold.reason}.`,
    };
  }
  switch (target.state) {
    case "live":
      return {
        label: "Publishing",
        tone: "live",
        explanation: "Echelon sends absolute quantities to this destination as availability changes.",
      };
    case "preview":
      return {
        label: "Calculating only",
        tone: "preview",
        explanation: "Quantities are calculated and recorded for readiness review. Nothing is sent "
          + "to the provider.",
      };
    default:
      return {
        label: "Not publishing",
        tone: "off",
        explanation: "No quantities are calculated or sent for this destination. Stock the "
          + "marketplace already shows is unchanged.",
      };
  }
}

function formatHeldAt(heldAt: string): string {
  const date = new Date(heldAt);
  return Number.isFinite(date.getTime()) ? `on ${date.toLocaleDateString()}` : "at an unknown time";
}

// ---------------------------------------------------------------------------
// Supply (fulfillment nodes)
// ---------------------------------------------------------------------------

export const NODE_TYPE_LABELS: Record<FulfillmentNode["nodeType"], string> = {
  internal_warehouse: "Warehouse",
  third_party_logistics: "3PL",
  virtual: "Virtual node",
};

export interface SupplyState {
  activeNodeIds: number[];
  draftNodeIds: number[] | null;
  /** The set the server's preview and readiness will use: draft when present. */
  savedNodeIds: number[];
  pending: boolean;
  configured: boolean;
}

export function describeSupply(head: PublicationSourceBindingHead | null): SupplyState {
  const activeNodeIds = head?.activeBinding?.fulfillmentNodeIds ?? [];
  const draftNodeIds = head?.draftBinding?.fulfillmentNodeIds ?? null;
  const savedNodeIds = draftNodeIds ?? activeNodeIds;
  return {
    activeNodeIds,
    draftNodeIds,
    savedNodeIds,
    pending: draftNodeIds !== null,
    configured: savedNodeIds.length > 0,
  };
}

export function nodeLabel(node: FulfillmentNode): string {
  return node.name === node.warehouseCode ? node.name : `${node.name} (${node.warehouseCode})`;
}

export function summarizeNodes(nodeIds: readonly number[], nodes: readonly FulfillmentNode[]): string {
  if (nodeIds.length === 0) return "none";
  return nodeIds
    .map((id) => nodes.find((node) => node.id === id)?.warehouseCode ?? `node #${id}`)
    .join(", ");
}

export function sameIdSet(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false;
  const sorted = [...left].sort((a, b) => a - b);
  return [...right].sort((a, b) => a - b).every((value, index) => value === sorted[index]);
}

// ---------------------------------------------------------------------------
// Policy fields, forms, and inheritance display
// ---------------------------------------------------------------------------

export type PolicyFieldKey = Exclude<keyof ChannelExposurePolicyValue, "sourceFulfillmentNodeIds" | "inheritAll">;

export interface PolicyFieldMeta {
  key: PolicyFieldKey;
  label: string;
  help: string;
  /** Source key reported by the server's resolved policy for this field. */
  sourceKey: keyof NonNullable<PreviewRow["policy"]>["sources"];
}

/** Presentation order follows the calculation order the server documents. */
export const POLICY_FIELDS: readonly PolicyFieldMeta[] = [
  {
    key: "eligible",
    label: "Sell on this channel",
    help: "When off, this channel shows zero regardless of the settings below.",
    sourceKey: "eligible",
  },
  {
    key: "shareBps",
    label: "Offer",
    help: "Share of available stock this channel may offer. A narrower rule replaces this "
      + "value; percentages never multiply.",
    sourceKey: "shareBps",
  },
  {
    key: "holdbackSellableUnits",
    label: "Keep back",
    help: "Units subtracted after the offer percentage. This is a selling choice for this "
      + "channel, not warehouse safety stock.",
    sourceKey: "holdbackSellableUnits",
  },
  {
    key: "maxPublish",
    label: "Maximum to show",
    help: "Cap on the quantity shown. \"No limit\" is an explicit choice.",
    sourceKey: "maxPublishSellableUnits",
  },
  {
    key: "minPublishSellableUnits",
    label: "Show zero below",
    help: "If the remaining quantity is smaller than this, the channel shows zero. Never "
      + "increases a quantity.",
    sourceKey: "minPublishSellableUnits",
  },
  {
    key: "allocationSemantics",
    label: "Stock sharing",
    help: "Shared pool: channels advertise from the same stock and orders compete for it. "
      + "Partitioned: overlapping shares are checked against the common budget before publishing.",
    sourceKey: "allocationSemantics",
  },
];

export const SEMANTICS_LABELS = {
  exposure: "Shared pool",
  partitioned: "Partitioned",
} as const;

/** One editable field: inherit (null) or an explicit value in text form. */
export interface PolicyForm {
  eligible: "inherit" | "yes" | "no";
  shareMode: "inherit" | "set";
  sharePercent: string;
  holdbackMode: "inherit" | "set";
  holdbackUnits: string;
  maxMode: "inherit" | "unlimited" | "units";
  maxUnits: string;
  minMode: "inherit" | "set";
  minUnits: string;
  semantics: "inherit" | "exposure" | "partitioned";
}

export const EMPTY_POLICY_FORM: PolicyForm = {
  eligible: "inherit",
  shareMode: "inherit",
  sharePercent: "",
  holdbackMode: "inherit",
  holdbackUnits: "",
  maxMode: "inherit",
  maxUnits: "",
  minMode: "inherit",
  minUnits: "",
  semantics: "inherit",
};

export function policyValueToForm(value: ChannelExposurePolicyValue | null): PolicyForm {
  if (!value) return EMPTY_POLICY_FORM;
  return {
    eligible: value.eligible === null ? "inherit" : value.eligible ? "yes" : "no",
    shareMode: value.shareBps === null ? "inherit" : "set",
    sharePercent: value.shareBps === null ? "" : bpsToPercentText(value.shareBps),
    holdbackMode: value.holdbackSellableUnits === null ? "inherit" : "set",
    holdbackUnits: value.holdbackSellableUnits ?? "",
    maxMode: value.maxPublish === null ? "inherit" : value.maxPublish.mode,
    maxUnits: value.maxPublish?.mode === "units" ? value.maxPublish.units : "",
    minMode: value.minPublishSellableUnits === null ? "inherit" : "set",
    minUnits: value.minPublishSellableUnits ?? "",
    semantics: value.allocationSemantics ?? "inherit",
  };
}

export interface PolicyFormError {
  field: PolicyFieldKey | "form";
  message: string;
}

export type PolicyFormResult =
  | { ok: true; value: ChannelExposurePolicyValue }
  | { ok: false; errors: PolicyFormError[] };

/**
 * Validates operator input into the exact server value. Inherit → null.
 * Channel defaults require explicit fields. Product/SKU editors may restore
 * all inheritance with a versioned tombstone instead of deleting the rule.
 */
export function policyFormToValue(form: PolicyForm, options: {
  allowInheritAll?: boolean; sourceFulfillmentNodeIds?: number[] | null;
} = {}): PolicyFormResult {
  const errors: PolicyFormError[] = [];
  let shareBps: number | null = null;
  if (form.shareMode === "set") {
    const parsed = percentTextToBps(form.sharePercent);
    if (parsed.ok) shareBps = parsed.value;
    else errors.push({ field: "shareBps", message: parsed.message });
  }
  let holdback: string | null = null;
  if (form.holdbackMode === "set") {
    const parsed = parseWholeUnits(form.holdbackUnits, "Keep back");
    if (parsed.ok) holdback = parsed.value;
    else errors.push({ field: "holdbackSellableUnits", message: parsed.message });
  }
  let maxPublish: ChannelExposurePolicyValue["maxPublish"] = null;
  if (form.maxMode === "unlimited") maxPublish = { mode: "unlimited" };
  if (form.maxMode === "units") {
    const parsed = parseWholeUnits(form.maxUnits, "Maximum to show");
    if (parsed.ok) maxPublish = { mode: "units", units: parsed.value };
    else errors.push({ field: "maxPublish", message: parsed.message });
  }
  let min: string | null = null;
  if (form.minMode === "set") {
    const parsed = parseWholeUnits(form.minUnits, "Show zero below");
    if (parsed.ok) min = parsed.value;
    else errors.push({ field: "minPublishSellableUnits", message: parsed.message });
  }
  const value: ChannelExposurePolicyValue = {
    allocationSemantics: form.semantics === "inherit" ? null : form.semantics,
    eligible: form.eligible === "inherit" ? null : form.eligible === "yes",
    shareBps,
    holdbackSellableUnits: holdback,
    maxPublish,
    minPublishSellableUnits: min,
    ...(options.sourceFulfillmentNodeIds == null ? {} : { sourceFulfillmentNodeIds: [...options.sourceFulfillmentNodeIds].sort((a,b) => a-b) }),
  };
  if (options.sourceFulfillmentNodeIds?.length === 0) errors.push({ field: "form", message: "Select at least one supply warehouse, or use inherited supply." });
  if (errors.length === 0 && Object.values(value).every((field) => field === null)) {
    if (options.allowInheritAll) value.inheritAll = true;
    else errors.push({
      field: "form",
      message: "A channel default needs explicit settings. Product and SKU exceptions can restore inheritance.",
    });
  }
  return errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}

export function samePolicyForm(left: PolicyForm, right: PolicyForm): boolean {
  return (Object.keys(left) as Array<keyof PolicyForm>).every((key) => left[key] === right[key]);
}

/** Human rendering of one explicit field value. */
export function formatFieldValue(field: PolicyFieldKey, value: ChannelExposurePolicyValue): string | null {
  switch (field) {
    case "eligible":
      return value.eligible === null ? null : value.eligible ? "Yes" : "No";
    case "shareBps":
      return value.shareBps === null ? null : formatPercent(value.shareBps);
    case "holdbackSellableUnits":
      return value.holdbackSellableUnits === null ? null : `${formatUnits(value.holdbackSellableUnits)} units`;
    case "maxPublish":
      if (value.maxPublish === null) return null;
      return value.maxPublish.mode === "unlimited" ? "No limit" : `${formatUnits(value.maxPublish.units)} units`;
    case "minPublishSellableUnits":
      return value.minPublishSellableUnits === null ? null : `${formatUnits(value.minPublishSellableUnits)} units`;
    case "allocationSemantics":
      return value.allocationSemantics === null ? null : SEMANTICS_LABELS[value.allocationSemantics];
  }
}

export function explicitFieldLabels(value: ChannelExposurePolicyValue): string[] {
  if (value.inheritAll) return ["Restore inheritance"];
  return [...(value.sourceFulfillmentNodeIds ? ["Supply warehouses"] : []), ...POLICY_FIELDS
    .filter((field) => formatFieldValue(field.key, value) !== null)
    .map((field) => field.label)];
}

// Scope keys match server/modules/inventory-planning/domain/inventory-channel-exposure.ts
// channelExposurePolicyScopeKey; the head's scopeKey is the join key everywhere.
export function scopeKeyFor(scope: ChannelExposurePolicyScope): string {
  if (scope.scopeType === "channel") return `channel:${scope.channelId}`;
  if (scope.scopeType === "product") return `channel:${scope.channelId}:product:${scope.productId}`;
  return `channel:${scope.channelId}:variant:${scope.productVariantId}`;
}

export function findPolicyHead(
  heads: readonly ChannelExposurePolicyHead[],
  scope: ChannelExposurePolicyScope,
): ChannelExposurePolicyHead | null {
  const key = scopeKeyFor(scope);
  return heads.find((head) => head.scopeKey === key) ?? null;
}

/** The saved definition a preview would use for a head: the draft when present. */
export function savedPolicy(head: ChannelExposurePolicyHead | null): {
  value: ChannelExposurePolicyValue;
  authority: DefinitionAuthority;
} | null {
  if (head?.draftPolicy) return { value: head.draftPolicy.value, authority: "draft" };
  if (head?.activePolicy) return { value: head.activePolicy.value, authority: "active" };
  return null;
}

export type SavedFieldSource =
  | { kind: "sku" | "product" | "channel"; display: string; authority: DefinitionAuthority; scopeKey: string }
  | { kind: "unset" };

export type SavedFieldSources = Record<PolicyFieldKey, SavedFieldSource>;

/**
 * Display-only inheritance readout for the exception editor: which saved rule
 * (SKU → product → channel, draft preferred) currently supplies each field for
 * the given scope's parents. Excludes the scope's own rule so the editor can
 * say "Inherit (50% from channel default)" while the SKU field is being edited.
 */
export function resolveSavedFields(
  heads: readonly ChannelExposurePolicyHead[],
  scope: ChannelExposurePolicyScope,
): SavedFieldSources {
  const chain: Array<{ kind: "sku" | "product" | "channel"; scope: ChannelExposurePolicyScope }> = [];
  if (scope.scopeType === "variant") {
    chain.push({ kind: "product", scope: { scopeType: "product", channelId: scope.channelId, productId: scope.productId } });
  }
  if (scope.scopeType !== "channel") {
    chain.push({ kind: "channel", scope: { scopeType: "channel", channelId: scope.channelId } });
  }
  const result = {} as SavedFieldSources;
  for (const field of POLICY_FIELDS) {
    let found: SavedFieldSource = { kind: "unset" };
    for (const link of chain) {
      const saved = savedPolicy(findPolicyHead(heads, link.scope));
      const display = saved ? formatFieldValue(field.key, saved.value) : null;
      if (saved && display !== null) {
        found = { kind: link.kind, display, authority: saved.authority, scopeKey: scopeKeyFor(link.scope) };
        break;
      }
    }
    result[field.key] = found;
  }
  return result;
}

export const SOURCE_KIND_LABELS = {
  sku: "SKU rule",
  product: "product rule",
  channel: "channel default",
  unset: "not set anywhere",
} as const;

/** Maps a server-reported source scope key onto an operator label. */
export function describeSourceScopeKey(scopeKey: string): "sku" | "product" | "channel" | "unset" {
  if (scopeKey.includes(":variant:")) return "sku";
  if (scopeKey.includes(":product:")) return "product";
  if (scopeKey.startsWith("channel:")) return "channel";
  return "unset";
}

/** Channel defaults must resolve every field before they can be sealed. */
export function missingChannelDefaultFields(value: ChannelExposurePolicyValue | null): string[] {
  if (!value) return POLICY_FIELDS.map((field) => field.label);
  return POLICY_FIELDS
    .filter((field) => formatFieldValue(field.key, value) === null)
    .map((field) => field.label);
}

// ---------------------------------------------------------------------------
// Exceptions (product / SKU rules) for a channel
// ---------------------------------------------------------------------------

export interface ExceptionRow {
  scopeKey: string;
  scopeType: "product" | "variant";
  head: ChannelExposurePolicyHead;
  subject: PolicySubject | null;
  title: string;
  subtitle: string;
  explicitFields: string[];
  pending: boolean;
  active: boolean;
  productId: number;
  productVariantId: number | null;
}

export function listExceptions(view: View, channelId: number): ExceptionRow[] {
  const subjects = new Map(view.policySubjects.map((subject) => [subject.scopeKey, subject]));
  return view.policyHeads
    .filter((head) => head.channelId === channelId)
    .flatMap((head) => {
      const saved = savedPolicy(head);
      const scope = head.draftPolicy?.scope ?? head.activePolicy?.scope ?? null;
      if (!saved || !scope || scope.scopeType === "channel") return [];
      if (saved.value.inheritAll && !head.draftPolicy) return [];
      const subject = subjects.get(head.scopeKey) ?? null;
      const productLabel = subject
        ? `${subject.productSku ? `${subject.productSku} · ` : ""}${subject.productName}`
        : `Product #${scope.productId}`;
      const isVariant = scope.scopeType === "variant";
      const variantLabel = isVariant
        ? subject?.variantSku ?? subject?.variantName ?? `SKU #${scope.productVariantId}`
        : null;
      return [{
        scopeKey: head.scopeKey,
        scopeType: scope.scopeType,
        head,
        subject,
        title: variantLabel ?? productLabel,
        subtitle: isVariant ? `${productLabel} · SKU rule` : "Whole product",
        explicitFields: explicitFieldLabels(saved.value),
        pending: head.draftPolicy !== null,
        active: head.activePolicy !== null,
        productId: scope.productId,
        productVariantId: isVariant ? scope.productVariantId : null,
        sortKey: [productLabel, isVariant ? 1 : 0, variantLabel ?? ""] as const,
      }];
    })
    // Group by product: the whole-product rule first, then its SKU rules.
    .sort((left, right) => left.sortKey[0].localeCompare(right.sortKey[0])
      || left.sortKey[1] - right.sortKey[1]
      || left.sortKey[2].localeCompare(right.sortKey[2])
      || left.scopeKey.localeCompare(right.scopeKey))
    .map(({ sortKey: _sortKey, ...row }) => row);
}

export function filterProducts(products: readonly ProductSummary[], query: string, limit: number): ProductSummary[] {
  const needle = query.trim().toLowerCase();
  const matches = needle.length === 0
    ? products
    : products.filter((product) =>
      product.name.toLowerCase().includes(needle) || (product.sku ?? "").toLowerCase().includes(needle));
  return matches.slice(0, limit);
}

export function productLabel(product: Pick<ProductSummary, "sku" | "name">): string {
  return product.sku ? `${product.sku} · ${product.name}` : product.name;
}

// ---------------------------------------------------------------------------
// Quantities (server preview rows)
// ---------------------------------------------------------------------------

export interface QuantityStep {
  label: string;
  units: string;
  /** What produced this step, in operator words. */
  detail: string;
}

export interface QuantityExplanation {
  steps: QuantityStep[];
  proposedUnits: string;
  /** Why the proposed quantity is zero, when a rule forced it. */
  zeroReason: string | null;
}

/**
 * Turns the server's breakdown into a readable chain. Every number comes from
 * the server row; this function only labels them.
 */
export function explainQuantity(row: PreviewRow): QuantityExplanation {
  const policy = row.policy;
  if (!policy) {
    return {
      steps: [{ label: "Available", units: row.canonicalAtpUnits, detail: "Canonical availability across the eligible warehouses." }],
      proposedUnits: row.publishedUnits,
      zeroReason: "No complete rule resolves for this SKU, so nothing can be proposed.",
    };
  }
  const steps: QuantityStep[] = [
    { label: "Available", units: row.canonicalAtpUnits, detail: "Canonical availability across the eligible warehouses." },
    { label: `Offer ${formatPercent(policy.shareBps)}`, units: row.sharedUnits, detail: "Share of availability this channel may offer." },
    { label: `Keep back ${formatUnits(policy.holdbackSellableUnits)}`, units: row.afterHoldbackUnits, detail: "Units held off this channel after the offer percentage." },
    {
      label: policy.maxPublishSellableUnits === null ? "No maximum" : `Maximum ${formatUnits(policy.maxPublishSellableUnits)}`,
      units: row.cappedUnits,
      detail: "Cap on the quantity shown.",
    },
    {
      label: `Show zero below ${formatUnits(policy.minPublishSellableUnits)}`,
      units: row.publishedUnits,
      detail: "Quantities under the threshold are shown as zero.",
    },
  ];
  let zeroReason: string | null = null;
  if (!policy.eligible) zeroReason = "This SKU is not eligible for the channel, so zero is proposed.";
  else if (row.publishedUnits === "0" && row.cappedUnits !== "0") {
    zeroReason = `Remaining ${formatUnits(row.cappedUnits)} is below the show-zero threshold of `
      + `${formatUnits(policy.minPublishSellableUnits)}.`;
  } else if (row.publishedUnits === "0" && row.canonicalAtpUnits === "0") {
    zeroReason = "No availability in the eligible warehouses.";
  }
  return { steps, proposedUnits: row.publishedUnits, zeroReason };
}

export interface WarehouseContribution {
  label: string;
  units: string;
}

export function describeWarehouseContributions(row: PreviewRow, nodes: readonly FulfillmentNode[]): WarehouseContribution[] {
  return row.sourceWarehouseBreakdown.map((entry) => ({
    label: nodes.find((node) => node.warehouseId === entry.warehouseId)?.warehouseCode
      ?? `Warehouse #${entry.warehouseId}`,
    units: entry.canonicalAtpUnits,
  }));
}

export type IdentityStatus =
  | { kind: "missing" }
  | { kind: "draft" | "active"; externalInventoryItemId: string; externalSku: string | null; version: number };

/** SKU identity at the exact destination, preferring the saved draft like the preview does. */
export function describeIdentity(head: PublicationVariantMappingHead | null): IdentityStatus {
  const mapping = head?.draftMapping ?? head?.activeMapping ?? null;
  if (!mapping) return { kind: "missing" };
  return {
    kind: head?.draftMapping ? "draft" : "active",
    externalInventoryItemId: mapping.externalInventoryItemId,
    externalSku: mapping.externalSku,
    version: mapping.version,
  };
}

export function findMappingHead(
  heads: readonly PublicationVariantMappingHead[],
  targetId: number,
  variantId: number,
): PublicationVariantMappingHead | null {
  return heads.find((head) => head.publicationTargetId === targetId && head.productVariantId === variantId) ?? null;
}

export function sellableVariants(variants: readonly Variant[]): Variant[] {
  return variants.filter((variant) => variant.isActive && variant.salesEligibility === "sellable");
}

// ---------------------------------------------------------------------------
// Pending changes (saved but not active)
// ---------------------------------------------------------------------------

export interface PendingChanges {
  supply: boolean;
  channelDefault: boolean;
  exceptionCount: number;
  identityCount: number;
  total: number;
}

/**
 * Drafts the head pointers still hold: saved configuration that the live
 * authority does not use until a separate activation process seals it.
 */
export function summarizePendingChanges(view: View, channelId: number, targetId: number | null): PendingChanges {
  const supply = targetId !== null
    && (view.sourceBindingHeads.find((head) => head.publicationTargetId === targetId)?.draftBinding ?? null) !== null;
  const channelHead = findPolicyHead(view.policyHeads, { scopeType: "channel", channelId });
  const channelDefault = channelHead?.draftPolicy !== null && channelHead !== null;
  const exceptionCount = view.policyHeads.filter((head) =>
    head.channelId === channelId && head.scopeKey !== `channel:${channelId}` && head.draftPolicy !== null).length;
  const identityCount = targetId === null
    ? 0
    : view.variantMappingHeads.filter((head) =>
      head.publicationTargetId === targetId && head.draftMapping !== null).length;
  return {
    supply,
    channelDefault,
    exceptionCount,
    identityCount,
    total: Number(supply) + Number(channelDefault) + exceptionCount + identityCount,
  };
}

// ---------------------------------------------------------------------------
// Channel rail
// ---------------------------------------------------------------------------

export interface ChannelRailEntry {
  channel: Channel;
  targets: Target[];
  liveCount: number;
  heldCount: number;
  previewCount: number;
  offCount: number;
  externalCount: number;
  hasChannelDefault: boolean;
  exceptionCount: number;
}

export function buildChannelRail(view: View): ChannelRailEntry[] {
  return view.channels.map((channel) => {
    const targets = view.publicationTargets.filter((target) => target.channelId === channel.id);
    const tones = targets.map((target) => describePublishing(target).tone);
    return {
      channel,
      targets,
      liveCount: tones.filter((tone) => tone === "live").length,
      heldCount: tones.filter((tone) => tone === "held").length,
      previewCount: tones.filter((tone) => tone === "preview").length,
      offCount: tones.filter((tone) => tone === "off").length,
      externalCount: tones.filter((tone) => tone === "external").length,
      hasChannelDefault: savedPolicy(findPolicyHead(view.policyHeads, { scopeType: "channel", channelId: channel.id })) !== null,
      exceptionCount: listExceptions(view, channel.id).length,
    };
  });
}

/** Keeps a selection valid across refetches: prefer the current id, else the first option. */
export function reconcileSelection<T extends { id: number }>(current: number | null, options: readonly T[]): number | null {
  if (current !== null && options.some((option) => option.id === current)) return current;
  return options[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// Destination setup (provider-adaptive)
// ---------------------------------------------------------------------------

export type DestinationOption =
  | {
    kind: "channel_connection";
    id: number;
    label: string;
    provider: string;
    scopeType: "location" | "account";
    /** Verified account id for account-scoped providers; null when not verified. */
    verifiedAccountId: string | null;
    verifiedAccountLabel: string | null;
    suggestedLocationId: string | null;
    supported: boolean;
  }
  | {
    kind: "dropship_store_connection";
    id: number;
    label: string;
    provider: string;
    scopeType: "account";
    verifiedAccountId: string | null;
    verifiedAccountLabel: string | null;
    suggestedLocationId: null;
    supported: boolean;
  };

/**
 * Destinations that can receive quantities under this channel's selling rules:
 * the channel's own store connections, plus dropship stores (which publish
 * through their own eBay credential while using the channel's rules).
 */
export function destinationOptionsFor(channel: Channel, view: View): DestinationOption[] {
  const existing = new Set(view.publicationTargets.map((target) =>
    `${target.destinationKind}:${target.channelConnectionId ?? target.dropshipStoreConnectionId}:${target.providerScopeType}:${target.externalScopeId}`));
  const connections: DestinationOption[] = channel.connections.map((connection) => {
    const adapter = isSupportedProvider(channel.provider) ? PUBLISHING_ADAPTERS[channel.provider] : null;
    return {
      kind: "channel_connection",
      id: connection.id,
      label: connection.providerAccount?.displayName ?? connection.externalAccountLabel ?? `Connection #${connection.id}`,
      provider: channel.provider,
      scopeType: adapter?.scopeType ?? "account",
      verifiedAccountId: connection.providerAccount?.externalAccountId ?? null,
      verifiedAccountLabel: connection.providerAccount?.displayName ?? null,
      suggestedLocationId: channel.provider === "shopify" ? connection.shopifyLocationId : connection.providerLocationId ?? null,
      supported: adapter !== null,
    };
  });
  // Dropship storefronts belong to the one internal dropship channel, never to
  // a marketplace channel. Offering them under Shopify or eBay would invite a
  // target whose channel_id contradicts how dropship quantities are actually
  // planned and published.
  const hostsDropshipStores = view.dropshipDestinationChannelId !== null
    && channel.id === view.dropshipDestinationChannelId;
  const stores: DestinationOption[] = (hostsDropshipStores ? view.dropshipStores : []).map((store) => ({
    kind: "dropship_store_connection",
    id: store.id,
    label: `${describeDropshipStore(store)} · ${providerLabel(store.platform)}`,
    provider: store.platform,
    scopeType: "account",
    verifiedAccountId: store.verifiedExternalAccountId,
    verifiedAccountLabel: store.externalAccountLabel,
    suggestedLocationId: null,
    // Only the eBay dropship transport is registered in the inspected composition.
    supported: store.platform === "ebay",
  }));
  // An account-scoped destination has exactly one possible scope id (the
  // verified account), so once registered it is not offered again. Location
  // scoped stores can still add further locations; the server rejects exact
  // duplicates either way.
  return [...connections, ...stores].filter((option) =>
    !(option.scopeType === "account" && option.verifiedAccountId !== null
      && existing.has(`${option.kind}:${option.id}:account:${option.verifiedAccountId}`)));
}

