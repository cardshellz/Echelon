import * as fs from "fs";
import * as path from "path";

// Add any deliberately unauthenticated routes here
const ALLOWED_UNAUTH_ROUTES = [
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/register",
  "/api/webhooks/shopify",
  "/api/webhooks/stripe-dropship",
  "/api/webhooks/subscription",
  "/api/shipstation/webhooks/ship-notify",
  "/api/oms/webhooks/orders/paid",
  "/api/oms/webhooks/orders/updated",
  "/api/oms/webhooks/orders/cancelled",
  "/api/oms/webhooks/orders/fulfilled",
  "/api/oms/webhooks/refunds/create",
  "/api/ebay/oauth/callback",
  "/api/ebay/oauth/declined",
  "/api/shopify/webhooks/products/create",
  "/api/shopify/webhooks/products/update",
  "/api/shopify/webhooks/products/delete",
  "/api/shopify/webhooks/fulfillments/create",
  "/api/shopify/webhooks/fulfillments/update",
  "/api/shopify/webhooks/orders/create",
  "/api/shopify/webhooks/orders/fulfilled",
  "/api/shopify/webhooks/orders/cancelled",
  "/api/vendor/auth/logout"
];

// Add the auth middleware names
const VALID_AUTH_MIDDLEWARES = [
  "requireAuth",
  "requirePermission",
  "requireVendorAuth",
  "requireInternalApiKey"
];

function scanDirectory(dir: string, fileList: string[] = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      scanDirectory(filePath, fileList);
    } else if (file.endsWith(".ts") && !file.endsWith(".test.ts")) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

function auditRoutes() {
  const targetDir = path.resolve(process.cwd(), "server");
  const files = scanDirectory(targetDir);
  
  let unauthenticatedCount = 0;
  const unauthenticatedRoutes: string[] = [];

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    // Match common expressive route patterns: app.get("/api/path", requireAuth, handler)
    const routeRegex = /app\.(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/g;
    let match;

    while ((match = routeRegex.exec(content)) !== null) {
      const method = match[1].toUpperCase();
      const routePath = match[2];
      
      // Get the full line of the matched route to check for middleware presence
      // (This requires finding the start of the match and taking a chunk of characters)
      const startIndex = match.index;
      // Get the next 200 chars to find middleware arguments
      const signatureChunk = content.substring(startIndex, startIndex + 200);

      const isAllowedUnauth = ALLOWED_UNAUTH_ROUTES.includes(routePath) || routePath.startsWith("/api/vendor/wallet/deposit"); // if wildcard needed
      
      let isAllowed = false;
      for (const allowed of ALLOWED_UNAUTH_ROUTES) {
          if (routePath === allowed || routePath.startsWith(allowed + "/")) {
              isAllowed = true;
          }
      }

      if (isAllowed) continue;

      // Check if there is an app.use("/prefix", validAuth) that covers this route
      const appUseRegex = /app\.use\(\s*["']([^"']+)["']\s*,\s*([^,)]+)/g;
      let useMatch;
      let coveredByAppUse = false;
      // We read the content again or just global match
      const contentForUse = content; 
      
      while ((useMatch = appUseRegex.exec(contentForUse)) !== null) {
          const prefix = useMatch[1];
          const middleware = useMatch[2].trim();
          if (routePath.startsWith(prefix)) {
              if (VALID_AUTH_MIDDLEWARES.some(m => middleware.includes(m))) {
                  coveredByAppUse = true;
                  break;
              }
          }
      }

      if (coveredByAppUse) continue;

      let hasValidMiddleware = false;
      for (const middleware of VALID_AUTH_MIDDLEWARES) {
        if (signatureChunk.includes(middleware)) {
          hasValidMiddleware = true;
          break;
        }
      }

      // Sometimes middleware is applied at the router level (e.g. router.use(requireAuth))
      // But typically Echelon passes the 'app' instance around directly and applies middleware to the route.
      // Echelon routes standard: app.get("/path", requireAuth, handler)
      
      if (!hasValidMiddleware) {
        // Double check if there's router-level middleware in the file.
        // E.g. router.use(requireAuth) -> wait, they don't do this often. If they do:
        if (content.includes("app.use(\"/api/subscriptions\", requireAuth") && routePath.startsWith("/api/subscriptions")) {
            hasValidMiddleware = true;
        }
        if (content.includes("app.use(\"/api/_internal/diagnostics\", requireInternalApiKey") && routePath.startsWith("/api/_internal/diagnostics")) {
            hasValidMiddleware = true;
        }
      }

      if (!hasValidMiddleware) {
        unauthenticatedCount++;
        unauthenticatedRoutes.push(`${file} -> ${method} ${routePath}`);
      }
    }
  }

  if (unauthenticatedCount > 0) {
    console.error(`❌ SECURITY AUDIT FAILED: Found ${unauthenticatedCount} unauthenticated API routes.`);
    unauthenticatedRoutes.forEach(r => console.error(`  - ${r}`));
    process.exit(1);
  } else {
    console.log("✅ SECURITY AUDIT PASSED: All unlisted API routes enforce authentication.");
    process.exit(0);
  }
}

auditRoutes();
