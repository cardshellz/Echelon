import type {
  ShopifyConnectionContext, ShopifyConnectionPreview, ShopifyProductConnectionExecute,
  ShopifyProductConnectionRequest,
} from "@shared/catalog/shopify-product-connection";
import {
  assertProductConnectionAllowed, buildShopifyConnectionCreateSpec, connectionFingerprint,
  eligibleConnectionVariants, parseShopifyProductReference, resolveConnectionBindings,
  ShopifyProductConnectionError, type ShopifyConnectionCreateSpec, type ShopifyConnectionRemoteProduct,
  type ShopifyConnectionReviewEvidence, type ShopifyConnectionSource,
} from "./shopify-product-connection.domain";
import {
  connectionOwnership, SHOPIFY_VARIANT_WRITE_BATCH_SIZE, ShopifyConnectionProviderError,
  type ShopifyProductConnectionProvider,
} from "./shopify-product-connection.provider";
import {
  publicConnectionCommand, type ShopifyConnectionCredentials, type ShopifyProductConnectionRepository,
  type StoredShopifyConnection,
} from "./shopify-product-connection.repository";
import { ShopifyProductMappingError, type ShopifyProductMappingService } from "./shopify-product-mapping.service";
import { publicationSelectionBusyIssue } from "../inventory-planning/publication-selection-work";
import { createChannelPricingService } from "../channels/channel-pricing.service";
import { ChannelPricingError } from "../channels/channel-pricing.domain";

interface ConnectionPlan {
  source: ShopifyConnectionSource;
  createSpec: ShopifyConnectionCreateSpec | null;
  review: ShopifyConnectionReviewEvidence;
  preview: ShopifyConnectionPreview;
}

function skuList(source: ShopifyConnectionSource): string[] {
  const variants = eligibleConnectionVariants(source);
  return (variants.length ? variants.map(variant => variant.sku) : [source.product.sku])
    .filter((sku): sku is string => Boolean(sku?.trim()));
}

function remoteFingerprint(remote: ShopifyConnectionRemoteProduct): string {
  // Stock quantities change independently and do not change product identity.
  // They must not invalidate an otherwise exact, reviewed linking decision.
  return connectionFingerprint({ id: remote.id, title: remote.title, status: remote.status,
    variants: remote.variants.map(variant => ({ id: variant.id, sku: variant.sku,
      inventoryItemId: variant.inventoryItemId, barcode: variant.barcode })).sort((left, right) => left.id < right.id ? -1 : 1) });
}

function localIdentity(source: ShopifyConnectionSource): string {
  return connectionFingerprint({ productId: source.product.id, active: source.product.isActive, productTrackingDefault: source.product.trackInventory,
    variants: eligibleConnectionVariants(source).map(variant => ({ id: variant.id, sku: variant.sku,
      requiresShipping: variant.requiresShipping, trackInventory: variant.trackInventory })) });
}

function safeFailure(error: unknown): { code: string; message: string; retryable: boolean; statusCode: number } {
  const busy = publicationSelectionBusyIssue(error);
  if (busy) return { code: busy.code, message: "A stock update is finishing. This Shopify command is saved; retry it shortly.", retryable: true, statusCode: 409 };
  if (error instanceof ShopifyProductConnectionError) return { code: error.code, message: error.message, retryable: error.retryable, statusCode: error.statusCode };
  if (error instanceof ShopifyProductMappingError) return { code: error.code, message: error.message, retryable: false, statusCode: error.statusCode };
  if (error instanceof ChannelPricingError) return { code: error.code, message: error.message, retryable: false, statusCode: error.status };
  return { code: "SHOPIFY_CONNECTION_INTERRUPTED", message: "The Shopify command was interrupted. Its intent is saved; resume it to verify the result.", retryable: true, statusCode: 503 };
}

export function createShopifyProductConnectionService(input: {
  repository: ShopifyProductConnectionRepository;
  provider: ShopifyProductConnectionProvider;
  mappingOwner: Pick<ShopifyProductMappingService, "repair">;
  onConnected?: (productId: number, trackedVariantIds: readonly number[]) => Promise<void>;
  log?: (event: Record<string, unknown>) => void;
}) {
  const { repository, provider, mappingOwner } = input;
  const log = input.log ?? (event => console.info(JSON.stringify(event)));

  async function account(source: ShopifyConnectionSource, request?: ShopifyProductConnectionRequest) {
    const credentials = await repository.credentials(source.channel.id, source.channel);
    if (credentials.apiVersion !== source.channel.apiVersion) {
      throw new ShopifyProductConnectionError("SHOPIFY_CONNECTION_CHANGED", "The Shopify API configuration changed. Refresh the product review.");
    }
    const capabilities = await provider.capabilities(credentials);
    if (request && capabilities.currency !== request.currency) {
      throw new ShopifyProductConnectionError("SHOPIFY_CURRENCY_CHANGED", "The Shopify store currency differs from the reviewed prices. Refresh the product review.");
    }
    if (request?.mode === "create" && !capabilities.scopes.has("write_products")) {
      throw new ShopifyProductConnectionError("SHOPIFY_PRODUCT_PERMISSION_REQUIRED", "This Shopify connection needs write_products permission to create products.", 422);
    }
    return { credentials, ...capabilities };
  }

  async function context(productId: number, requestedChannelId?: number): Promise<ShopifyConnectionContext> {
    const channels = await repository.configuredChannels();
    const selected = requestedChannelId ? channels.find(channel => channel.id === requestedChannelId) : channels[0];
    if (!selected) throw new ShopifyProductConnectionError("SHOPIFY_CHANNEL_UNAVAILABLE", "Select a configured active Shopify channel.", 422);
    const source = await repository.source(productId, selected.id);
    const live = await account(source);
    let blockedReason: string | null = null;
    try { assertProductConnectionAllowed(source); } catch (error) { blockedReason = safeFailure(error).message; }
    let publications: ShopifyConnectionContext["publications"] = [];
    let publicationIssue: string | null = null;
    if (live.scopes.has("read_publications") && live.scopes.has("write_publications")) {
      try { publications = await provider.publications(live.credentials); }
      catch (error) { publicationIssue = safeFailure(error).message; }
    } else publicationIssue = "Publishing needs read_publications and write_publications permissions. Creating a draft and linking existing products remain available.";
    let matchingProducts: ShopifyConnectionContext["matchingProducts"] = [];
    let lookupIssue: string | null = null;
    try { matchingProducts = await provider.matches(live.credentials, skuList(source)); }
    catch (error) { lookupIssue = safeFailure(error).message; }
    const pending = await repository.pending(productId, selected.id);
    return {
      productId, productName: source.product.name, productSku: source.product.sku,
      channels: channels.map(channel => ({ ...channel, isDefault: channel.isDefault === 1 })),
      channelId: selected.id, shopDomain: live.credentials.shopDomain, currency: live.currency,
      mappingStatus: source.mapping.status, mappedProductId: source.mapping.catalogProductId,
      variants: eligibleConnectionVariants(source).map(variant => ({ ...variant,
        priceCents: (variant.priceCurrency ?? "USD") === live.currency ? variant.priceCents : null,
        compareAtPriceCents: (variant.priceCurrency ?? "USD") === live.currency ? variant.compareAtPriceCents : null,
      })), productOnly: source.variants.length === 0,
      blockedReason, publications, publicationIssue, matchingProducts, lookupIssue,
      pendingCommand: pending ? publicConnectionCommand(pending) : null,
    };
  }

  async function plan(productId: number, request: ShopifyProductConnectionRequest): Promise<ConnectionPlan> {
    const source = await repository.source(productId, request.channelId);
    assertProductConnectionAllowed(source);
    const live = await account(source, request);
    const issues: string[] = [];
    const warnings: string[] = [];
    let publicationName: string | null = null;
    if (request.publicationId) {
      if (!live.scopes.has("write_publications") || !live.scopes.has("read_publications")) {
        throw new ShopifyProductConnectionError("SHOPIFY_PUBLICATION_PERMISSION_REQUIRED", "This Shopify connection needs publication permissions, or you can create a draft.", 422);
      }
      const publications = await provider.publications(live.credentials);
      publicationName = publications.find(publication => publication.id === request.publicationId)?.name ?? null;
      if (!publicationName) throw new ShopifyProductConnectionError("SHOPIFY_PUBLICATION_NOT_FOUND", "The selected publication no longer belongs to this Shopify store.");
    }
    let createSpec: ShopifyConnectionCreateSpec | null = null;
    let review: ShopifyConnectionReviewEvidence = { remoteProductId: null, remoteFingerprint: null, bindings: [] };
    let targetTitle = source.product.title || source.product.name;
    let remoteVariants: ShopifyConnectionPreview["remoteVariants"] = [];
    let variants: ShopifyConnectionPreview["variants"];
    if (request.mode === "create") {
      createSpec = buildShopifyConnectionCreateSpec(source, request);
      const matches = await provider.matches(live.credentials, skuList(source));
      if (matches.length) issues.push(`Shopify already has matching SKU evidence: ${matches.map(match => `${match.title} (${match.id})`).join(", ")}. Review Link existing product.`);
      variants = createSpec.variants.map(variant => ({ variantId: variant.localVariantId, sku: variant.sku,
        name: variant.name, remoteVariantId: null, priceCents: variant.priceCents }));
      warnings.push(publicationName ? `Create a draft, finish and verify its variants and mappings, then publish only to ${publicationName}.` : "Create a draft in Shopify. It will remain unpublished.");
    } else {
      const targetProductId = parseShopifyProductReference(request.targetProductRef!, source.channel.shopDomain);
      const known = [source.mapping.catalogProductId, ...source.mapping.evidenceProductIds].filter(Boolean);
      if (known.some(id => id !== targetProductId)) throw new ShopifyProductConnectionError("SHOPIFY_PRODUCT_ALREADY_CONNECTED", "This catalog product already points to a different Shopify product. Resolve its existing mapping first.");
      const remote = await provider.product(live.credentials, targetProductId);
      if (remote.status === "ARCHIVED") throw new ShopifyProductConnectionError("SHOPIFY_PRODUCT_ARCHIVED", "Restore this Shopify product before connecting it.");
      targetTitle = remote.title;
      remoteVariants = remote.variants.map(variant => ({ id: variant.id, sku: variant.sku, title: variant.title }));
      let bindings: ShopifyConnectionReviewEvidence["bindings"] = [];
      try { bindings = resolveConnectionBindings(source, remote, request.bindings); }
      catch (error) {
        if (!(error instanceof ShopifyProductConnectionError) || error.code !== "SHOPIFY_VARIANT_SELECTION_REQUIRED") throw error;
        issues.push(error.message);
      }
      review = { remoteProductId: remote.id, remoteFingerprint: remoteFingerprint(remote), bindings };
      variants = eligibleConnectionVariants(source).map(variant => {
        const chosen = bindings.find(binding => binding.variantId === variant.id)?.remoteVariantId
          ?? request.bindings.find(binding => binding.variantId === variant.id)?.remoteVariantId;
        const matching = chosen ? remote.variants.filter(candidate => candidate.id === chosen)
          : remote.variants.filter(candidate => variant.sku && candidate.sku?.trim().toUpperCase() === variant.sku.trim().toUpperCase());
        return { variantId: variant.id, sku: variant.sku, name: variant.name,
          remoteVariantId: matching.length === 1 ? matching[0].id : null, priceCents: matching.length === 1 ? matching[0].priceCents : null };
      });
      warnings.push("Link this existing product and the reviewed variants. Its content, photos, prices and publication stay as they are.");
      if (variants.some(variant => variant.remoteVariantId && remote.variants.find(candidate => candidate.id === variant.remoteVariantId)?.sku?.trim().toUpperCase() !== variant.sku?.trim().toUpperCase())) {
        warnings.push("One or more explicitly selected Shopify SKUs differ from the catalog SKU. Review each selected variant carefully.");
      }
    }
    if (source.variants.some(variant => !variant.isActive || variant.salesEligibility === "internal_only")) warnings.push("Archived and internal-only variants are excluded.");
    warnings.push("Inventory quantities continue through Channel Inventory; this command does not adjust stock.");
    const previewHash = connectionFingerprint({ source, request, createSpec, review, publicationName });
    return { source, createSpec, review, preview: {
      previewHash, mode: request.mode, productId, productName: source.product.name, channelId: request.channelId,
      channelName: source.channel.name, shopDomain: source.channel.shopDomain, currency: request.currency,
      targetProductId: review.remoteProductId, targetTitle, variants, remoteVariants, publicationName,
      ready: issues.length === 0, issues, warnings,
    } };
  }

  async function preview(productId: number, request: ShopifyProductConnectionRequest): Promise<ShopifyConnectionPreview> {
    return (await plan(productId, request)).preview;
  }

  async function status(productId: number, commandKey: string) {
    const command = await repository.find(commandKey);
    if (!command || command.productId !== productId) throw new ShopifyProductConnectionError("SHOPIFY_COMMAND_NOT_FOUND", "The saved Shopify command was not found for this product.", 404);
    return publicConnectionCommand(command);
  }

  async function claim(productId: number, executeInput: ShopifyProductConnectionExecute, actor: string, runNow: boolean) {
    if (!actor.trim()) throw new ShopifyProductConnectionError("SHOPIFY_ACTOR_REQUIRED", "An authenticated operator is required.", 403);
    let saved = await repository.find(executeInput.commandKey);
    if (saved && (saved.productId !== productId || saved.channelId !== executeInput.request.channelId
      || saved.previewHash !== executeInput.previewHash || connectionFingerprint(saved.request) !== connectionFingerprint(executeInput.request))) {
      throw new ShopifyProductConnectionError("SHOPIFY_COMMAND_KEY_REUSED", "This command key belongs to a different reviewed request.");
    }
    if (saved?.state === "complete") return saved;
    if (saved?.state === "rejected") throw new ShopifyProductConnectionError(saved.lastErrorCode ?? "SHOPIFY_COMMAND_REJECTED", saved.lastErrorMessage ?? "This command was rejected. Review a new request.", 409, false);
    if (!saved) {
      const reviewed = await plan(productId, executeInput.request);
      if (reviewed.preview.previewHash !== executeInput.previewHash || !reviewed.preview.ready) {
        throw new ShopifyProductConnectionError("SHOPIFY_PREVIEW_STALE", "The product or Shopify evidence changed, or a variant selection remains unresolved. Refresh the review.");
      }
      saved = await repository.reserve({ commandKey: executeInput.commandKey, productId, request: executeInput.request,
        previewHash: executeInput.previewHash, source: reviewed.source, createSpec: reviewed.createSpec, review: reviewed.review, actor }, { runNow });
    } else saved = await repository.reserve({ commandKey: saved.commandKey, productId, request: saved.request,
      previewHash: saved.previewHash, source: saved.source, createSpec: saved.createSpec, review: saved.review, actor }, { runNow });
    return saved;
  }

  async function submit(productId: number, executeInput: ShopifyProductConnectionExecute, actor: string) {
    const command = await claim(productId, executeInput, actor, false);
    if (command.state === "complete") return { command: publicConnectionCommand(command), replayed: true };
    const queued = await repository.step(command, { actor, state: "pending", eventType: "command_queued", release: true });
    return { command: publicConnectionCommand(queued), replayed: false };
  }

  async function execute(productId: number, executeInput: ShopifyProductConnectionExecute, actor: string) {
    let command: StoredShopifyConnection = await claim(productId, executeInput, actor, true);
    if (command.state === "complete") return { command: publicConnectionCommand(command), replayed: true };
    const step = async (details: Parameters<ShopifyProductConnectionRepository["step"]>[1]) => {
      command = await repository.step(command, details);
    };
    const heartbeat = async () => { await step({ actor, state: command.state, eventType: "verification_progress" }); };
    try {
      const live = await account(command.source, command.request);
      let remote: ShopifyConnectionRemoteProduct;
      if (command.mode === "link") {
        remote = await provider.product(live.credentials, command.review.remoteProductId!, heartbeat);
        if (remoteFingerprint(remote) !== command.review.remoteFingerprint) throw new ShopifyProductConnectionError("SHOPIFY_REMOTE_CHANGED", "The reviewed Shopify product or variant identities changed. Review a new linking request.");
      } else {
        const ownership = connectionOwnership(command.channelId, command.productId, command.commandKey);
        if (command.remoteProductId) remote = await provider.product(live.credentials, command.remoteProductId, heartbeat);
        else if (command.createRequested) {
          const recovered = await provider.owned(live.credentials, command.commandKey, ownership, heartbeat);
          if (!recovered) throw new ShopifyProductConnectionError("SHOPIFY_CREATE_OUTCOME_UNKNOWN", "Shopify has not yet confirmed the earlier create request. Retry this saved command to look for it; Echelon will not create another product.", 503, true);
          remote = recovered;
          await step({ actor, state: "configuring", eventType: "created_product_recovered", remoteProductId: remote.id });
        } else {
          const existing = await provider.matches(live.credentials, skuList(command.source), heartbeat);
          if (existing.length) throw new ShopifyProductConnectionError("SHOPIFY_PRODUCT_EXISTS", "Shopify now contains a matching SKU. Review Link existing product instead.");
          await step({ actor, state: "creating", eventType: "product_create_requested", createRequested: true });
          const seed = command.source.product.sku || `${command.createSpec!.title}-${command.productId}`;
          const handle = seed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0,180) || `product-${command.productId}`;
          const remoteProductId = await provider.create(live.credentials, { spec: command.createSpec!, commandKey: command.commandKey, ownership, handle });
          await step({ actor, state: "configuring", eventType: "created_product_recorded", remoteProductId });
          remote = await provider.product(live.credentials, remoteProductId, heartbeat);
        }
        if (remote.ownership !== ownership) throw new ShopifyProductConnectionError("SHOPIFY_CREATE_OWNERSHIP_MISMATCH", "The recovered Shopify product does not carry this exact creation command's ownership marker.");
        remote = await configureVariants(live.credentials, command.createSpec!, remote, ownership, step, heartbeat, actor);
        await provider.verifyMedia(live.credentials, remote.id, command.createSpec!.images.length, heartbeat);
      }
      await step({ actor, state: "mapping", eventType: "mapping_requested", remoteProductId: remote.id });
      const current = await repository.source(productId, command.channelId);
      if (localIdentity(current) !== localIdentity(command.source)) {
        throw new ShopifyProductConnectionError("SHOPIFY_CATALOG_IDENTITY_CHANGED", "The catalog's active SKUs or inventory policies changed after review. The Shopify draft is retained for review.");
      }
      const bindings = command.mode === "link" ? command.review.bindings : eligibleConnectionVariants(command.source).map(variant => {
        const matching = remote.variants.filter(candidate => candidate.localVariantId === variant.id);
        if (matching.length !== 1) throw new ShopifyProductConnectionError("SHOPIFY_VARIANT_EVIDENCE_MISSING", "A created variant is missing its exact catalog identity.");
        return { variantId: variant.id, remoteVariantId: matching[0].id };
      });
      const alreadyApplied = current.mapping.status === "consistent" && current.mapping.catalogProductId === remote.id
        && bindings.every(binding => current.mapping.variants.some(variant => variant.variantId === binding.variantId && variant.catalogVariantId === binding.remoteVariantId));
      await mappingOwner.repair({ productId, channelId: command.channelId, targetProductId: remote.id, actor,
        verifiedShopifyProduct: { id: remote.id, title: remote.title, variants: remote.variants },
        operatorVariantBindings: bindings,
        expectedMappingFingerprint: alreadyApplied ? undefined : command.source.mapping.fingerprint,
        afterMapping: command.mode === "create" ? async (transaction, at) => {
          const pricing = createChannelPricingService(transaction);
          for (const variant of command.createSpec!.variants) {
            if (variant.localVariantId === null) continue;
            const expected = command.source.variants.find(sourceVariant => sourceVariant.id === variant.localVariantId)?.channelPrice;
            await pricing.savePrice(command.channelId, variant.localVariantId, {
              price: variant.priceCents, compareAtPrice: variant.compareAtPriceCents, currency: command.request.currency,
            }, actor, at, expected ?? null);
          }
        } : undefined,
      });
      await step({ actor, state: command.request.publicationId ? "publishing" : "mapping", eventType: "mapping_committed" });
      await input.onConnected?.(productId, eligibleConnectionVariants(command.source)
        .filter(variant => variant.requiresShipping && variant.trackInventory).map(variant => variant.id));
      if (command.request.publicationId) {
        await finishPublication(live.credentials, remote.id, command.request.publicationId, step, heartbeat, actor);
      }
      await step({ actor, state: "complete", eventType: "command_completed", result: {
        productId, channelId: command.channelId, remoteProductId: remote.id, bindings,
        publicationId: command.request.publicationId, mode: command.mode,
      } });
      log({ code: "SHOPIFY_PRODUCT_CONNECTION_COMPLETED", actor, commandKey: command.commandKey, productId, channelId: command.channelId, remoteProductId: remote.id, mode: command.mode });
      return { command: publicConnectionCommand(command), replayed: false };
    } catch (error) {
      const failure = safeFailure(error);
      const noExternalCreation = !command.createRequested || error instanceof ShopifyConnectionProviderError && error.writeOutcome === "not_applied" && command.remoteProductId === null;
      const rejected = !failure.retryable && (command.mode === "link" || noExternalCreation || command.remoteProductId !== null)
        || error instanceof ShopifyConnectionProviderError && error.writeOutcome === "not_applied" && command.mode === "create" && command.remoteProductId === null;
      if (rejected && command.mode === "create" && command.remoteProductId) {
        failure.message += ` Shopify product ${command.remoteProductId} is retained. Correct the issue, then review Link existing product.`;
      }
      await step({ actor, state: rejected ? "rejected" : "review", eventType: "command_interrupted", error: failure,
        details: { code: failure.code, retryable: failure.retryable }, release: true });
      log({ code: failure.code, actor, commandKey: command.commandKey, productId, channelId: command.channelId, state: command.state, retryable: failure.retryable });
      throw new ShopifyProductConnectionError(failure.code, failure.message, failure.statusCode, failure.retryable, error);
    }
  }

  type Step = (details: Parameters<ShopifyProductConnectionRepository["step"]>[1]) => Promise<void>;

  async function configureVariants(credentials: ShopifyConnectionCredentials, spec: ShopifyConnectionCreateSpec,
    initial: ShopifyConnectionRemoteProduct, ownership: string, step: Step, heartbeat: () => Promise<void>, actor: string) {
    let remote = initial;
    for (let batchIndex = 0; batchIndex <= Math.ceil(spec.variants.length / SHOPIFY_VARIANT_WRITE_BATCH_SIZE); batchIndex += 1) {
      const owned = remote.variants.filter(variant => variant.ownership === ownership);
      const foreign = remote.variants.filter(variant => variant.ownership !== ownership);
      const removablePlaceholder = owned.length === 0 && foreign.length === 1 && remote.status === "DRAFT"
        && !foreign[0].sku && !foreign[0].barcode && foreign[0].priceCents === 0 && foreign[0].inventoryQuantity === 0
        && foreign[0].optionValue === spec.variants[0].optionValue;
      if (foreign.length > 0 && !removablePlaceholder) throw new ShopifyProductConnectionError("SHOPIFY_CREATED_PRODUCT_CHANGED", "The new Shopify draft has unrecognized or modified variants. Review it before continuing; no existing variants were removed.");
      if (owned.some(variant => !spec.variants.some(expected => expected.localVariantId === variant.localVariantId))) {
        throw new ShopifyProductConnectionError("SHOPIFY_CREATED_PRODUCT_CHANGED", "The new Shopify draft contains an unexpected catalog variant marker.");
      }
      const missing = spec.variants.filter(expected => {
        const matching = owned.filter(variant => variant.localVariantId === expected.localVariantId);
        if (matching.length > 1) throw new ShopifyProductConnectionError("SHOPIFY_VARIANT_AMBIGUOUS", "More than one Shopify variant carries the same catalog identity.");
        const actual = matching[0];
        if (!actual) return true;
        if ((actual.sku?.trim() || null) !== (expected.sku?.trim() || null) || actual.priceCents !== expected.priceCents
          || (actual.compareAtPriceCents ?? null) !== expected.compareAtPriceCents || (actual.barcode?.trim() || null) !== (expected.barcode?.trim() || null)
          || actual.requiresShipping !== expected.requiresShipping || actual.trackInventory !== expected.trackInventory
          || actual.optionValue !== expected.optionValue) {
          throw new ShopifyProductConnectionError("SHOPIFY_CREATED_VARIANT_CHANGED", "A created Shopify variant's SKU, price, package or inventory policy differs from the saved creation intent.");
        }
        return false;
      });
      if (!missing.length) return remote;
      const batch = missing.slice(0, SHOPIFY_VARIANT_WRITE_BATCH_SIZE);
      await step({ actor, state: "configuring", eventType: "variant_create_requested",
        details: { localVariantIds: batch.map(variant => variant.localVariantId), batchHash: connectionFingerprint(batch) } });
      await provider.createVariants(credentials, { productId: remote.id, variants: batch, ownership, removePlaceholder: removablePlaceholder });
      const previousOwned = owned.length;
      remote = await provider.product(credentials, remote.id, heartbeat);
      if (remote.variants.filter(variant => variant.ownership === ownership).length <= previousOwned) {
        throw new ShopifyProductConnectionError("SHOPIFY_VARIANT_OUTCOME_UNKNOWN", "Shopify has not confirmed the requested variants. Resume the saved command to verify them.", 503, true);
      }
    }
    throw new ShopifyProductConnectionError("SHOPIFY_VARIANT_PROGRESS_LIMIT", "The variant setup did not finish within its bounded progress limit.", 503, true);
  }

  async function finishPublication(credentials: ShopifyConnectionCredentials, productId: string, publicationId: string,
    step: Step, heartbeat: () => Promise<void>, actor: string): Promise<void> {
    const remote = await provider.product(credentials, productId, heartbeat);
    if (remote.status !== "ACTIVE") {
      await step({ actor, state: "publishing", eventType: "activation_requested" });
      await provider.activate(credentials, productId);
    }
    if (!await provider.published(credentials, productId, publicationId)) {
      await step({ actor, state: "publishing", eventType: "publication_requested", details: { publicationId } });
      await provider.publish(credentials, productId, publicationId);
    }
    if ((await provider.product(credentials, productId, heartbeat)).status !== "ACTIVE" || !await provider.published(credentials, productId, publicationId)) {
      throw new ShopifyProductConnectionError("SHOPIFY_PUBLICATION_UNCONFIRMED", "Shopify has not confirmed the selected publication. The product mapping is saved; resume to verify publication.", 503, true);
    }
  }

  async function processDue(limit = 3) {
    const commands = await repository.due(limit);
    const result = { selected: commands.length, completed: 0, reviewRequired: 0 };
    for (const command of commands) {
      try {
        await execute(command.productId, { commandKey: command.commandKey, request: command.request, previewHash: command.previewHash }, "system:shopify_product_connection_worker");
        result.completed += 1;
      } catch (error) {
        const failure = safeFailure(error);
        if (failure.code !== "SHOPIFY_COMMAND_IN_PROGRESS" && failure.code !== "SHOPIFY_COMMAND_STALE_OWNER") {
          result.reviewRequired += 1;
          log({ code: "SHOPIFY_PRODUCT_CONNECTION_WORKER_DEFERRED", commandKey: command.commandKey,
            productId: command.productId, channelId: command.channelId, errorCode: failure.code });
        }
      }
    }
    return result;
  }

  return { context, preview, submit, execute, status, processDue };
}

export type ShopifyProductConnectionService = ReturnType<typeof createShopifyProductConnectionService>;
