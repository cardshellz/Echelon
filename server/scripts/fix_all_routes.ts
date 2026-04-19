import * as fs from "fs";
import * as path from "path";

const ALLOWED_UNAUTH_ROUTES = [
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/register",
  "/api/webhooks/shopify",
  "/api/webhooks/stripe-dropship",
  "/api/webhooks/subscription",
  "/api/shipstation/webhooks/ship-notify"
];

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

function autoFix() {
  const targetDir = path.resolve(process.cwd(), "server");
  const files = scanDirectory(targetDir);
  
  for (const file of files) {
    let content = fs.readFileSync(file, "utf8");
    let changed = false;

    const routeRegex = /app\.(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/g;
    let match;
    const replacements: Array<{start: number, end: number, oldText: string, newText: string}> = [];

    // First collect all necessary replacements
    while ((match = routeRegex.exec(content)) !== null) {
      const methodStr = match[0];
      const routePath = match[2];
      
      const startIndex = match.index;
      // Get the next 300 chars to find the callback boundary
      const chunk = content.substring(startIndex, startIndex + 300);

      // Check if allowed
      let isAllowed = false;
      for (const allowed of ALLOWED_UNAUTH_ROUTES) {
          if (routePath === allowed || routePath.startsWith(allowed + "/")) {
              isAllowed = true;
          }
      }
      if (routePath.startsWith("/api/shopify/webhooks/") || 
          routePath.startsWith("/api/oms/webhooks/") || 
          routePath.startsWith("/api/ebay/oauth/callback") ||
          routePath.startsWith("/api/ebay/oauth/declined")) {
          isAllowed = true;
      }

      if (isAllowed) continue;

      let hasValidMiddleware = false;
      for (const middleware of VALID_AUTH_MIDDLEWARES) {
        if (chunk.includes(middleware)) {
          hasValidMiddleware = true;
          break;
        }
      }

      // We skip app.use checks here and just insert requireAuth
      if (!hasValidMiddleware) {
        // Find the comma right after the string
        let quoteMatch = chunk.match(/app\.(get|post|put|patch|delete)\s*\(\s*["'][^"']+["']\s*,/);
        if (quoteMatch) {
          // We need to inject `requireAuth, ` after the first comma.
          const insertPos = startIndex + quoteMatch.index! + quoteMatch[0].length;
          
          replacements.push({
            start: insertPos,
            end: insertPos,
            oldText: "",
            newText: " requireAuth,"
          });
          
          // Also ensure requireAuth is imported in this file
          if (!content.includes("requireAuth")) {
            // we will add it at the top later
            changed = true;
          }
        }
      }
    }

    if (replacements.length > 0) {
      // Sort replacements in reverse order so string indices don't shift
      replacements.sort((a, b) => b.start - a.start);
      for (const repl of replacements) {
        content = content.substring(0, repl.start) + repl.newText + content.substring(repl.end);
      }
      
      if (!content.includes("requireAuth")) {
        // naive import injection
        content = 'import { requireAuth } from "../../routes/middleware";\n' + content;
      }
      
      fs.writeFileSync(file, content);
      console.log(`Autofixed ${replacements.length} routes in ${file}`);
    }
  }
}

autoFix();
