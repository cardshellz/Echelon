// Retired: this script inserted URL-only eBay images outside the Catalog owner
// and disabled TLS verification. The authenticated import endpoint now uses
// Catalog's shared original-photo importer and retains the source bytes.
console.error(JSON.stringify({
  code: "LEGACY_EBAY_IMAGE_IMPORT_RETIRED",
  message: "Use the authenticated eBay image import endpoint instead: POST /api/ebay/import-images.",
}));
process.exitCode = 1;
