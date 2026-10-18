import { createRoot } from "react-dom/client";
import { useState } from "react";
import { SupplierEvidenceImportDialog } from "../../../client/src/features/supplier-catalog/SupplierEvidenceImportDialog";
import { Toaster } from "../../../client/src/components/ui/toaster";
import "../../../client/src/index.css";

function ImportHarness() {
  const [open, setOpen] = useState(true);
  const [applied, setApplied] = useState(0);
  return <main><button onClick={() => setOpen(true)}>Import supplier evidence</button>
    <output aria-label="Completed imports">{applied}</output>
    <SupplierEvidenceImportDialog open={open} onOpenChange={setOpen} initialVendorId={7}
      vendors={[{ id: 7, code: "TEST", name: "Synthetic supplier", active: 1 }]}
      onApplied={() => setApplied(count => count + 1)} /><Toaster /></main>;
}
createRoot(document.getElementById("root")!).render(<ImportHarness />);
