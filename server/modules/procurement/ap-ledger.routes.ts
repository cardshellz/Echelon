import type { Express } from "express";
import { requirePermission, upload } from "../../routes/middleware";
import { requireIdempotency } from "../../middleware/idempotency";
import * as apLedger from "./ap-ledger.service";

function handleApLedgerError(res: any, err: any, fallbackStatus = 400) {
  if (err?.name === "ApLedgerError") {
    return res.status(err.statusCode).json({ error: err.message, details: err.details });
  }
  return res.status(err?.statusCode ?? fallbackStatus).json({ error: err.message });
}

function getUserId(req: any): string | undefined {
  return req.user?.id ?? req.session?.user?.id;
}

export function registerApLedgerRoutes(app: Express) {
  // ============================================================
  // AP LEDGER - Vendor invoices
  // ============================================================

  app.get("/api/vendor-invoices", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const { vendorId, inboundShipmentId, status, overdue, dueBefore, limit, offset } = req.query;
      const invoices = await apLedger.listInvoices({
        vendorId: vendorId ? Number(vendorId) : undefined,
        inboundShipmentId: inboundShipmentId ? Number(inboundShipmentId) : undefined,
        status: status ? (Array.isArray(status) ? status as string[] : (status as string).split(",")) : undefined,
        overdue: overdue === "true",
        dueBefore: dueBefore ? new Date(dueBefore as string) : undefined,
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
      });
      res.json({ invoices });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/vendor-invoices/next-number", requirePermission("purchasing", "view"), async (_req, res) => {
    try {
      const invoiceNumber = await apLedger.generateInvoiceNumber();
      res.json({ invoiceNumber });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/vendor-invoices", requirePermission("purchasing", "create"), async (req, res) => {
    try {
      const body = req.body;
      if (!body.vendorId || !body.invoiceNumber) {
        return res.status(400).json({ error: "vendorId and invoiceNumber are required" });
      }
      const invoice = await apLedger.createInvoice({
        ...body,
        invoiceDate: body.invoiceDate ? new Date(body.invoiceDate) : undefined,
        dueDate: body.dueDate ? new Date(body.dueDate) : undefined,
        createdBy: (req as any).user?.id,
      });
      res.status(201).json(invoice);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/vendor-invoices/:id", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const invoice = await apLedger.getInvoiceById(Number(req.params.id));
      if (!invoice) return res.status(404).json({ error: "Invoice not found" });
      res.json(invoice);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/vendor-invoices/:id", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const invoice = await apLedger.updateInvoice(Number(req.params.id), {
        ...req.body,
        invoiceDate: req.body.invoiceDate ? new Date(req.body.invoiceDate) : undefined,
        dueDate: req.body.dueDate ? new Date(req.body.dueDate) : undefined,
        updatedBy: (req as any).user?.id,
      });
      res.json(invoice);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/vendor-invoices/:id/approve", requirePermission("purchasing", "approve"), requireIdempotency(), async (req, res) => {
    try {
      const invoice = await apLedger.executeApLedgerCommand("approve_invoice", {
        invoiceId: Number(req.params.id),
        userId: getUserId(req),
      });
      res.json(invoice);
    } catch (err: any) {
      handleApLedgerError(res, err);
    }
  });

  app.post("/api/vendor-invoices/:id/dispute", requirePermission("purchasing", "edit"), requireIdempotency(), async (req, res) => {
    try {
      const { reason } = req.body;
      const invoice = await apLedger.executeApLedgerCommand("dispute_invoice", {
        invoiceId: Number(req.params.id),
        reason,
        userId: getUserId(req),
      });
      res.json(invoice);
    } catch (err: any) {
      handleApLedgerError(res, err);
    }
  });

  app.post("/api/vendor-invoices/:id/void", requirePermission("purchasing", "approve"), requireIdempotency(), async (req, res) => {
    try {
      const { reason } = req.body;
      const invoice = await apLedger.executeApLedgerCommand("void_invoice", {
        invoiceId: Number(req.params.id),
        reason,
        userId: getUserId(req),
      });
      res.json(invoice);
    } catch (err: any) {
      handleApLedgerError(res, err);
    }
  });

  app.post("/api/vendor-invoices/:id/po-links", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const { purchaseOrderId, allocatedAmountCents, notes } = req.body;
      if (!purchaseOrderId) return res.status(400).json({ error: "purchaseOrderId is required" });
      const link = await apLedger.linkPoToInvoice(Number(req.params.id), purchaseOrderId, allocatedAmountCents, notes);
      res.status(201).json(link);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/vendor-invoices/:id/po-links/:poId", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      await apLedger.unlinkPoFromInvoice(Number(req.params.id), Number(req.params.poId));
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/purchase-orders/:id/invoices", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const invoices = await apLedger.getInvoicesForPo(Number(req.params.id));
      res.json({ invoices });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Invoice lines

  app.post("/api/vendor-invoices/:id/lines/from-po", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const { purchaseOrderId } = req.body;
      if (!purchaseOrderId) return res.status(400).json({ error: "purchaseOrderId is required" });
      const lines = await apLedger.importLinesFromPO(Number(req.params.id), purchaseOrderId);
      res.status(201).json({ lines });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/vendor-invoices/:id/lines", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const line = await apLedger.addInvoiceLine(Number(req.params.id), req.body);
      res.status(201).json(line);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/vendor-invoice-lines/:lineId", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const line = await apLedger.updateInvoiceLine(Number(req.params.lineId), req.body);
      res.json(line);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/vendor-invoice-lines/:lineId", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      await apLedger.removeInvoiceLine(Number(req.params.lineId));
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/vendor-invoices/:id/match", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const lines = await apLedger.runInvoiceMatch(Number(req.params.id));
      res.json({ lines });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Invoice attachments

  app.post("/api/vendor-invoices/:id/attachments", requirePermission("purchasing", "edit"), upload.single("file"), async (req, res) => {
    try {
      const invoiceId = Number(req.params.id);
      const file = req.file;
      if (!file) return res.status(400).json({ error: "No file uploaded" });

      // Store to disk: uploads/invoices/{invoiceId}/
      const fs = await import("fs");
      const path = await import("path");
      const dir = path.join("uploads", "invoices", String(invoiceId));
      fs.mkdirSync(dir, { recursive: true });

      const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      const filePath = path.join(dir, `${Date.now()}_${safeName}`);
      fs.writeFileSync(filePath, file.buffer);

      const attachment = await apLedger.addAttachment(invoiceId, {
        fileName: file.originalname,
        fileType: file.mimetype,
        fileSizeBytes: file.size,
        filePath,
        uploadedBy: (req as any).user?.id,
        notes: req.body.notes,
      });
      res.status(201).json(attachment);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/vendor-invoices/:id/attachments", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const attachments = await apLedger.getAttachments(Number(req.params.id));
      res.json({ attachments });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/vendor-invoice-attachments/:id/download", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const attachment = await apLedger.getAttachmentById(Number(req.params.id));
      if (!attachment) return res.status(404).json({ error: "Attachment not found" });

      const fs = await import("fs");
      if (!fs.existsSync(attachment.filePath)) return res.status(404).json({ error: "File not found on disk" });

      res.download(attachment.filePath, attachment.fileName);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/vendor-invoice-attachments/:id", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const attachment = await apLedger.getAttachmentById(Number(req.params.id));
      if (attachment) {
        const fs = await import("fs");
        try { fs.unlinkSync(attachment.filePath); } catch {}
      }
      await apLedger.removeAttachment(Number(req.params.id));
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ============================================================
  // AP LEDGER - Payments
  // ============================================================

  app.get("/api/ap-payments", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const { vendorId, status, paymentMethod, dateFrom, dateTo, limit, offset } = req.query;
      const rows = await apLedger.listPayments({
        vendorId: vendorId ? Number(vendorId) : undefined,
        status: status ? (Array.isArray(status) ? status as string[] : (status as string).split(",")) : undefined,
        paymentMethod: paymentMethod as string | undefined,
        dateFrom: dateFrom ? new Date(dateFrom as string) : undefined,
        dateTo: dateTo ? new Date(dateTo as string) : undefined,
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
      });
      res.json({ payments: rows.map(r => ({ ...r.payment, vendorName: r.vendorName, vendorCode: r.vendorCode })) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/ap-payments", requirePermission("purchasing", "approve"), requireIdempotency(), async (req, res) => {
    try {
      const body = req.body;
      if (!body.vendorId || !body.paymentDate || !body.paymentMethod || body.totalAmountCents == null) {
        return res.status(400).json({ error: "vendorId, paymentDate, paymentMethod, and totalAmountCents are required" });
      }
      const payment = await apLedger.executeApLedgerCommand("record_payment", {
        payment: {
          ...body,
          paymentDate: new Date(body.paymentDate),
          allocations: body.allocations ?? [],
          createdBy: getUserId(req),
        },
      });
      res.status(201).json(payment);
    } catch (err: any) {
      handleApLedgerError(res, err);
    }
  });

  app.get("/api/ap-payments/:id", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const payment = await apLedger.getPaymentById(Number(req.params.id));
      if (!payment) return res.status(404).json({ error: "Payment not found" });
      res.json(payment);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/ap-payments/:id/void", requirePermission("purchasing", "approve"), requireIdempotency(), async (req, res) => {
    try {
      const { reason } = req.body;
      const result = await apLedger.executeApLedgerCommand("void_payment", {
        paymentId: Number(req.params.id),
        reason,
        userId: getUserId(req),
      });
      res.json(result);
    } catch (err: any) {
      handleApLedgerError(res, err);
    }
  });

  // ============================================================
  // AP LEDGER - Summary / Aging
  // ============================================================

  app.get("/api/ap/summary", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const summary = await apLedger.getApSummary();
      res.json(summary);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/ap/command-events", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const events = await apLedger.listApLedgerCommandAudit(req.query.limit ? Number(req.query.limit) : undefined);
      res.json({ events });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

}
