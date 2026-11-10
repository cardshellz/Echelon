// The Inventory owner interprets its provider-attempt evidence; other modules
// may ask whether an attempt can still arrive but cannot claim delivery.
export { readQuantityProviderFinality } from "./infrastructure/quantity-provider-finality.reader";
export { sameQuantityProviderScope } from "./domain/quantity-provider-finality";
export type { QuantityPublicationScope } from "./domain/quantity-publication-admission";
