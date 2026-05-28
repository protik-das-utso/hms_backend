import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import dayjs from "dayjs";
import { prisma } from "../../config/db";
import { ok, created, paginate } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import { getPagination } from "../../utils/pagination";
import { applyMovement, pickFefo } from "../../utils/stockMovement";
import { createInvoice } from "../../utils/invoiceBuilder";

interface SaleLine {
  medicineId: string;
  qty: number;
  unit?: "PIECE" | "BOX"; // defaults to PIECE
  discount?: number; // per-line discount in BDT
  batchId?: string;  // optional override of FEFO pick
}

interface SaleBody {
  branchId?: string;
  patientId?: string;
  prescriptionId?: string;
  admissionId?: string; // when set, charges go to the admission instead of a new invoice
  customerName?: string;
  customerPhone?: string;
  notes?: string;
  items: SaleLine[];
  discountAmount?: number;
  vatPercent?: number;
  initialPayment?: {
    amount: number;
    method: "CASH" | "BKASH" | "NAGAD" | "ROCKET" | "CARD" | "BANK_TRANSFER";
    referenceNo?: string;
  };
}

export const list = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const { page, pageSize, skip, take } = getPagination(req);
  const branchId = req.query.branchId as string | undefined;
  const status = req.query.status as string | undefined;
  const q = (req.query.q as string | undefined)?.trim();

  const where: Prisma.PharmacySaleWhereInput = {
    tenantId,
    ...(branchId ? { branchId } : {}),
    ...(status ? { status: status as Prisma.PharmacySaleWhereInput["status"] } : {}),
    ...(q
      ? {
          OR: [
            { saleNumber: { contains: q, mode: "insensitive" } },
            { customerName: { contains: q, mode: "insensitive" } },
            { customerPhone: { contains: q } },
            { patient: { name: { contains: q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.pharmacySale.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take,
      include: {
        patient: { select: { id: true, name: true, patientCode: true } },
        soldBy: { select: { id: true, name: true } },
        invoice: { select: { id: true, invoiceNumber: true, totalAmount: true, dueAmount: true, status: true } },
        _count: { select: { items: true } },
      },
    }),
    prisma.pharmacySale.count({ where }),
  ]);
  ok(res, rows, "OK", paginate(page, pageSize, total));
};

export const getOne = async (req: Request, res: Response) => {
  const sale = await prisma.pharmacySale.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId },
    include: {
      patient: { select: { id: true, name: true, patientCode: true, phone: true } },
      branch: { select: { id: true, name: true } },
      soldBy: { select: { id: true, name: true } },
      invoice: { include: { payments: { include: { collectedBy: { select: { name: true } } } } } },
      items: {
        include: {
          medicine: { select: { id: true, brandName: true, genericName: true, strength: true, form: true } },
          batch: { select: { id: true, batchNumber: true, expiryDate: true } },
        },
      },
    },
  });
  if (!sale) throw ApiError.notFound("Sale not found");
  ok(res, sale);
};

export const create = async (req: Request, res: Response) => {
  const body = req.body as SaleBody;
  const { tenantId, sub: userId, branchId: userBranchId } = req.auth!;
  const branchId = body.branchId ?? userBranchId;
  if (!branchId) throw ApiError.badRequest("branchId required (assign user to a branch)");
  if (!body.items?.length) throw ApiError.badRequest("At least one item required");

  // When billing to an admission, the patient is implied by the admission and
  // there's no standalone invoice — the charges roll into the discharge bill.
  let admissionPatientId: string | null = null;
  if (body.admissionId) {
    const a = await prisma.admission.findFirst({
      where: { id: body.admissionId, tenantId, status: "ADMITTED" },
      select: { id: true, patientId: true },
    });
    if (!a) throw ApiError.badRequest("Active admission not found");
    admissionPatientId = a.patientId;
    if (body.patientId && body.patientId !== a.patientId) {
      throw ApiError.badRequest("patientId does not match the admission's patient");
    }
  } else if (!body.patientId) {
    // MVP: every outpatient sale gets an Invoice, and Invoice.patientId is
    // non-nullable. Walk-ins must be quick-registered as patients (name +
    // phone) before billing. We can relax this later by making
    // Invoice.patientId nullable and routing walk-in payments through a
    // dedicated cash-account flow.
    throw ApiError.badRequest("patientId is required");
  }
  const effectivePatientId = admissionPatientId ?? body.patientId!;

  // Pre-validate medicines + compute picks (still inside the tx below for atomicity)
  const result = await prisma.$transaction(async (tx) => {
    const medicines = await tx.medicine.findMany({
      where: {
        tenantId,
        deletedAt: null,
        isActive: true,
        id: { in: body.items.map((i) => i.medicineId) },
      },
    });
    if (medicines.length !== body.items.length) {
      throw ApiError.badRequest("Some medicines are invalid or inactive");
    }
    const medById = new Map(medicines.map((m) => [m.id, m]));

    // Per-item: pick FEFO batches (or use the explicitly chosen batch).
    // `qty` on the request is in the line's unit (PIECE or BOX). Stock is
    // always tracked in pieces, so we translate when looking up batches and
    // again when writing the StockMovement.
    type PickedLine = {
      line: SaleLine;
      medicineId: string;
      brandName: string;
      unit: "PIECE" | "BOX";
      unitsPerBox: number;
      unitPrice: number;          // per unit (box or piece)
      // Each pick.qty is in the LINE'S unit. Stock delta = -(pick.qty * piecesPerUnit).
      picks: { batchId: string; qty: number }[];
    };
    const picked: PickedLine[] = [];
    for (const line of body.items) {
      const m = medById.get(line.medicineId)!;
      if (line.qty <= 0) throw ApiError.badRequest(`Qty must be positive for ${m.brandName}`);
      const unit = line.unit ?? "PIECE";
      const unitsPerBox = m.unitsPerBox ?? 1;
      if (unit === "BOX") {
        if (m.boxPrice == null) {
          throw ApiError.badRequest(`${m.brandName} is not priced by the box`);
        }
        if (unitsPerBox < 1) {
          throw ApiError.badRequest(`${m.brandName} has invalid unitsPerBox`);
        }
      }
      const piecesPerUnit = unit === "BOX" ? unitsPerBox : 1;
      const piecesNeeded = line.qty * piecesPerUnit;
      const unitPrice = unit === "BOX" ? Number(m.boxPrice) : Number(m.salePrice);

      if (line.batchId) {
        // Explicit batch — verify and reserve
        const batch = await tx.medicineBatch.findFirst({
          where: { id: line.batchId, tenantId, medicineId: m.id, branchId },
        });
        if (!batch) throw ApiError.badRequest(`Batch not found for ${m.brandName}`);
        // Block selling expired stock even when the cashier explicitly picks
        // the batch (the FEFO and box paths already filter by expiry).
        if (batch.expiryDate.getTime() < Date.now()) {
          throw ApiError.badRequest(
            `Batch ${batch.batchNumber} of ${m.brandName} expired on ${batch.expiryDate.toISOString().slice(0, 10)} — cannot sell`
          );
        }
        if (batch.qtyOnHand < piecesNeeded) {
          throw ApiError.badRequest(`Insufficient stock in batch ${batch.batchNumber} for ${m.brandName}`);
        }
        picked.push({
          line,
          medicineId: m.id,
          brandName: m.brandName,
          unit,
          unitsPerBox,
          unitPrice,
          picks: [{ batchId: batch.id, qty: line.qty }],
        });
      } else if (unit === "BOX") {
        // Box sales aren't split across batches — a "box" is a physical pack
        // and slicing it across lots makes no sense to the patient or the
        // stock auditor. Find the earliest-expiring batch with enough pieces.
        const candidates = await tx.medicineBatch.findMany({
          where: {
            tenantId,
            medicineId: m.id,
            branchId,
            qtyOnHand: { gte: piecesNeeded },
            expiryDate: { gte: new Date() },
          },
          orderBy: { expiryDate: "asc" },
          take: 1,
        });
        if (candidates.length === 0) {
          throw ApiError.badRequest(`No single batch has ${line.qty} box(es) of ${m.brandName}`);
        }
        picked.push({
          line,
          medicineId: m.id,
          brandName: m.brandName,
          unit,
          unitsPerBox,
          unitPrice,
          picks: [{ batchId: candidates[0].id, qty: line.qty }],
        });
      } else {
        const fefo = await pickFefo({ tenantId, medicineId: m.id, branchId, qty: piecesNeeded }, tx);
        picked.push({
          line,
          medicineId: m.id,
          brandName: m.brandName,
          unit,
          unitsPerBox,
          unitPrice,
          // FEFO returned pieces; for PIECE unit that's a 1:1 mapping.
          picks: fefo.map((p) => ({ batchId: p.batchId, qty: p.qty })),
        });
      }
    }

    // Build sale + items (one PharmacySaleItem per (line, batch) pick)
    const todayStart = dayjs().startOf("day").toDate();
    const seq = await tx.pharmacySale.count({
      where: { tenantId, createdAt: { gte: todayStart } },
    });
    const saleNumber = `PSL-${dayjs().format("YYMMDD")}-${String(seq + 1).padStart(5, "0")}`;

    const sale = await tx.pharmacySale.create({
      data: {
        tenantId,
        branchId,
        patientId: effectivePatientId,
        prescriptionId: body.prescriptionId ?? null,
        customerName: body.customerName ?? null,
        customerPhone: body.customerPhone ?? null,
        saleNumber,
        status: "COMPLETED",
        notes: body.notes ?? null,
        soldById: userId,
      },
    });

    const lineDescriptions: { description: string; amount: number; unitPrice: number; qty: number; discount: number; batchId: string; saleItemId: string }[] = [];

    for (const p of picked) {
      // Per-line discount is distributed proportionally across batch picks
      // when a single line is satisfied from multiple batches. Edge case
      // rarely happens (BD pharmacy usually keeps one active batch per
      // medicine per branch), but keep it correct.
      const lineDiscount = p.line.discount ?? 0;
      const totalQty = p.picks.reduce((s, x) => s + x.qty, 0);
      const piecesPerUnit = p.unit === "BOX" ? p.unitsPerBox : 1;
      const unitLabel = p.unit === "BOX" ? "box" : "pc";

      for (const pick of p.picks) {
        const portionDiscount = totalQty === 0 ? 0 : (lineDiscount * pick.qty) / totalQty;
        const gross = p.unitPrice * pick.qty;
        const net = gross - portionDiscount;

        const saleItem = await tx.pharmacySaleItem.create({
          data: {
            saleId: sale.id,
            medicineId: p.medicineId,
            batchId: pick.batchId,
            qty: pick.qty,
            unit: p.unit,
            unitsPerBox: p.unitsPerBox,
            unitPrice: new Prisma.Decimal(p.unitPrice),
            discount: new Prisma.Decimal(portionDiscount),
            amount: new Prisma.Decimal(net),
          },
        });

        await applyMovement(
          {
            tenantId,
            batchId: pick.batchId,
            // Stock always tracked in pieces — box sales decrement by qty * unitsPerBox.
            delta: -(pick.qty * piecesPerUnit),
            reason: "SALE",
            createdById: userId,
            refTable: "pharmacy_sales",
            refId: sale.id,
          },
          tx
        );

        lineDescriptions.push({
          description: `${p.brandName} (${pick.qty} ${unitLabel}${pick.qty > 1 ? "s" : ""})${p.picks.length > 1 ? " — batch slice" : ""}`,
          amount: net,
          unitPrice: p.unitPrice,
          qty: pick.qty,
          discount: portionDiscount,
          batchId: pick.batchId,
          saleItemId: saleItem.id,
        });
      }
    }

    // Inpatient billing path — write IpdCharge rows instead of a new invoice.
    // The discharge flow will fold these into the final IPD bill via
    // invoiceBuilder when the patient is discharged.
    if (body.admissionId) {
      for (const l of lineDescriptions) {
        await tx.ipdCharge.create({
          data: {
            tenantId,
            admissionId: body.admissionId,
            chargeDate: dayjs().startOf("day").toDate(),
            chargeType: "MEDICINE",
            description: l.description,
            qty: l.qty,
            unitPrice: new Prisma.Decimal(l.unitPrice),
            amount: new Prisma.Decimal(l.amount),
            refTable: "pharmacy_sale_items",
            refId: l.saleItemId,
            createdById: userId,
          },
        });
      }

      return tx.pharmacySale.findUnique({
        where: { id: sale.id },
        include: {
          items: {
            include: {
              medicine: { select: { brandName: true, strength: true } },
              batch: { select: { batchNumber: true, expiryDate: true } },
            },
          },
        },
      });
    }

    // Outpatient billing — create the standalone invoice as before.
    const invoice = await createInvoice(
      {
        tenantId,
        branchId,
        patientId: effectivePatientId,
        kind: "PHARMACY",
        discountAmount: body.discountAmount,
        vatPercent: body.vatPercent,
        collectedById: userId,
        initialPayment: body.initialPayment,
        lines: lineDescriptions.map((l) => ({
          lineType: "MEDICINE" as const,
          description: l.description,
          unitPrice: l.unitPrice,
          qty: l.qty,
          discount: l.discount,
          refTable: "medicine_batches",
          refId: l.batchId,
        })),
      },
      tx
    );

    await tx.pharmacySale.update({
      where: { id: sale.id },
      data: { invoiceId: invoice.id },
    });

    return tx.pharmacySale.findUnique({
      where: { id: sale.id },
      include: {
        items: {
          include: {
            medicine: { select: { brandName: true, strength: true } },
            batch: { select: { batchNumber: true, expiryDate: true } },
          },
        },
        invoice: true,
      },
    });
  });

  created(res, result, "Sale completed");
};

/**
 * Day-end summary for the pharmacy: totals, payment mix.
 */
export const dayEnd = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const date = (req.query.date as string | undefined) ?? dayjs().format("YYYY-MM-DD");
  const start = dayjs(date).startOf("day").toDate();
  const end = dayjs(date).endOf("day").toDate();
  const branchId = req.query.branchId as string | undefined;

  const where: Prisma.PharmacySaleWhereInput = {
    tenantId,
    createdAt: { gte: start, lte: end },
    status: "COMPLETED",
    ...(branchId ? { branchId } : {}),
  };

  const sales = await prisma.pharmacySale.findMany({
    where,
    include: {
      invoice: { include: { payments: true } },
      items: true,
    },
  });

  let revenue = 0;
  let collected = 0;
  let due = 0;
  let qty = 0;
  const byMethod: Record<string, number> = {};

  for (const s of sales) {
    qty += s.items.reduce((sum, it) => sum + it.qty, 0);
    if (s.invoice) {
      revenue += Number(s.invoice.totalAmount);
      collected += Number(s.invoice.paidAmount);
      due += Number(s.invoice.dueAmount);
      for (const p of s.invoice.payments) {
        byMethod[p.method] = (byMethod[p.method] ?? 0) + Number(p.amount);
      }
    }
  }

  ok(res, {
    date,
    saleCount: sales.length,
    itemQty: qty,
    revenue,
    collected,
    due,
    paymentMix: byMethod,
  });
};

