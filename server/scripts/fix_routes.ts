import * as fs from "fs";
import * as path from "path";

const FIX_FILES = [
  "server/routes/ebay-channel.routes.ts",
  "server/routes/ebay-listing-rules.routes.ts",
  "server/routes/ebay-oauth.routes.ts",
  "server/routes/ebay-settings.routes.ts",
  "server/routes/oms.routes.ts",
  "server/routes/shopify.routes.ts",
];

const IGNORED_PATHS_REGEX = [
  /^\/api\/shopify\/webhooks\/.*/,
  /^\/api\/ebay\/oauth\/(callback|declined|consent)/,
  /^\/api\/shopify\/oauth\/.*/,
];

function doRewrite() {
  for (const rel of FIX_FILES) {
    const fpath = path.resolve(process.cwd(), rel);
    if (!fs.existsSync(fpath)) continue;

    let content = fs.readFileSync(fpath, "utf8");
    let changed = false;

    // 1. Ensure requireAuth is imported if not present
    if (!content.includes("requireAuth")) {
      content = 'import { requireAuth } from "./middleware";\n' + content;
      changed = true;
    }

    // 2. Replace app.METHOD("/path", async (req
    // with app.METHOD("/path", requireAuth, async (req
    const regex = /app\.(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']\s*,\s*(async\s+)?(\([^)]*\)\s*=>)/g;
    
    content = content.replace(regex, (match, method, routePath, isAsync, paramsArgs) => {
      // Check if ignored
      let ignored = false;
      for (const rx of IGNORED_PATHS_REGEX) {
        if (rx.test(routePath)) {
          ignored = true;
          break;
        }
      }
      
      if (ignored) {
        return match;
      }
      
      changed = true;
      return `app.${method}("${routePath}", requireAuth, ${isAsync || ''}${paramsArgs}`;
    });

    if (changed) {
      fs.writeFileSync(fpath, content);
      console.log(`Fixed: ${rel}`);
    } else {
      console.log(`No changes for: ${rel}`);
    }
  }
}

doRewrite();
