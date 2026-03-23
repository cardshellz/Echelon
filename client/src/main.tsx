import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Ensure all fetch calls include credentials (session cookie)
const originalFetch = window.fetch;
window.fetch = function (input, init) {
  const url = typeof input === "string" ? input : input instanceof Request ? input.url : "";
  if (url.startsWith("/api")) {
    init = { ...init, credentials: init?.credentials || "include" };
  }
  return originalFetch.call(this, input, init);
};

createRoot(document.getElementById("root")!).render(<App />);
