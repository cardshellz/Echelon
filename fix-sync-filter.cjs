const fs = require('fs');
let src = fs.readFileSync('server/routes/ebay/ebay-sync-helpers.ts', 'utf8');

// There's an `interface SyncFilter { ... }` block that needs to be removed.
// Since it's exactly 5 lines, we can just remove it using regex.
src = src.replace(/interface SyncFilter \{\r?\n  productIds\?: number\[\];\r?\n  productTypeSlugs\?: string\[\];\r?\n  variantIds\?: number\[\];\r?\n\}/g, '');

fs.writeFileSync('server/routes/ebay/ebay-sync-helpers.ts', src);
console.log('Fixed duplicate SyncFilter');
