import { createRoot } from "react-dom/client";
import { CustomerReturnStorefrontPage } from "./CustomerReturnStorefrontPage";
import { returnPortalPageConfigSchema } from "./return-portal-config";
import "../index.css";
import "./storefront.css";
import "./return-portal.css";

const root = document.getElementById("csz-return-portal");
const config = document.getElementById("csz-return-portal-config");
if (root && config) {
  try {
    const parsed = returnPortalPageConfigSchema.parse(JSON.parse(config.textContent ?? ""));
    createRoot(root).render(<CustomerReturnStorefrontPage config={parsed} />);
  } catch {
    // Fail visibly without making an unscoped request or exposing config data.
    const message = document.createElement("p");
    message.setAttribute("role", "alert");
    message.textContent = "Returns could not be loaded. Refresh this page or contact us for help.";
    root.replaceChildren(message);
    console.error(JSON.stringify({ event: "storefront_return_page_failed", code: "RETURN_PAGE_CONFIG_INVALID" }));
  }
}
