import React from "react";
import { createRoot } from "react-dom/client";
import { ReturnParcelReceivingCard } from "../../../client/src/components/returns/ReturnParcelReceivingCard";
import "../../../client/src/index.css";

createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-4xl p-4">
    <ReturnParcelReceivingCard />
  </main>,
);
