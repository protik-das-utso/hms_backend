import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import dayjs from "dayjs";
import { prisma } from "../../config/db";
import { ok, created, paginate } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import { getPagination } from "../../utils/pagination";
import { applyMovement } from "../../utils/stockMovement";

/**
 * Current stock per (medicine, branch) — sums all live batches.
 * Filters: branchId, q (medicine name), lowOnly, expiringDays.
 */
export const currentStock = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const branchId = req.query.branchId as string | undefined;
  const q = (req.query.q as string | undefined)?.trim();
  const lowOnly = req.query.lowOnly === "true";
  const expiringDays = req.query.expiringDays ? Number(req.query.expiringDays) : null;
  const { page, pageSize, skip, take } = getPagination(req);

  // We list batches and project (medicine, branch) groupings on the client
  // for now — keeps the query simple. If/when this scales, push the grouping
  // into a database view.
  const where: Prisma.MedicineBatchWhereInput = {
    tenantId,
    qtyOnHand: { gt: 0 },
    ...(branchId ? { branchId } : {}),
    ...(expiringDays != null
      ? { expiryDate: { lte: dayjs().add(expiringDays, "day").toDate() } }
      : {}),
    medicine: {
      deletedAt: null,
      ...(q
        ? {
            OR: [
              { brandName: { contains: q, mode: "insensitive" } },
              { genericName: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
  };

  const [rows, total] = await Promise.all([
    prisma.medicineBatch.findMany({
      where,
      orderBy: [{ expiryDate: "asc" }, { medicine: { brandName: "asc" } }],
      skip,
      take,
      include: {
        medicine: { select: { id: true, brandName: true, genericName: true, strength: true, form: true, salePrice: true, reorderLevel: true } },
        branch: { select: { id: true, name: true } },
        supplier: { select: { id: true, name: true } },
      },
    }),
    prisma.medicineBatch.count({ where }),
  ]);

  const filtered = lowOnly
    ? rows.filter((b) => b.qtyOnHand <= b.medicine.reorderLevel)
    : rows;

  ok(res, filtered, "OK", paginate(page, pageSize, lowOnly ? filtered.length : total));
};

/**
 * FEFO-ordered batches for one medicine at one branch, used by the POS to
 * preview which lot will be drawn from.
 */
export const batchesForMedicine = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const medicineId = req.query.medicineId as string | undefined;
  const branchId = req.query.branchId as string | undefined;
  if (!medicineId || !branchId) throw ApiError.badRequest("medicineId and branchId are required");
  const rows = await prisma.medicineBatch.findMany({
    where: {
      tenantId,
      medicineId,
      branchId,
      qtyOnHand: { gt: 0 },
      expiryDate: { gte: new Date() },
    },
    orderBy: { expiryDate: "asc" },
    select: {
      id: true, batchNumber: true, expiryDate: true, mrp: true, qtyOnHand: true,
    },
  });
  ok(res, rows);
};

/**
 * Receive a new batch into stock — creates the batch row and a corresponding
 * PURCHASE StockMovement. Used in lieu of a full PO/GRN workflow for MVP.
 */
export const receiveBatch = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const userId = req.auth!.sub;
  const body = req.body as {
    medicineId: string;
    branchId: string;
    supplierId?: string;
    batchNumber: string;
    expiryDate: string;
    mrp: number;
    purchasePrice: number;
    qty: number;
  };

  const [medicine, branch, supplier] = await Promise.all([
    prisma.medicine.findFirst({ where: { id: body.medicineId, tenantId, deletedAt: null } }),
    prisma.branch.findFirst({ where: { id: body.branchId, tenantId } }),
    body.supplierId
      ? prisma.supplier.findFirst({ where: { id: body.supplierId, tenantId } })
      : Promise.resolve(null),
  ]);
  if (!medicine) throw ApiError.notFound("Medicine not found");
  if (!branch) throw ApiError.notFound("Branch not found");
  if (body.supplierId && !supplier) throw ApiError.notFound("Supplier not found");
  if (body.qty <= 0) throw ApiError.badRequest("Qty must be positive");

  const result = await prisma.$transaction(async (tx) => {
    const batch = await tx.medicineBatch.create({
      data: {
        tenantId,
        medicineId: body.medicineId,
        branchId: body.branchId,
        supplierId: body.supplierId ?? null,
        batchNumber: body.batchNumber,
        expiryDate: new Date(body.expiryDate),
        mrp: new Prisma.Decimal(body.mrp),
        purchasePrice: new Prisma.Decimal(body.purchasePrice),
        qtyReceived: body.qty,
        qtyOnHand: 0,
      },
    });
    await applyMovement(
      {
        tenantId,
        batchId: batch.id,
        delta: body.qty,
        reason: "PURCHASE",
        createdById: userId,
        refTable: "medicine_batches",
        refId: batch.id,
      },
      tx
    );
    // Update supplier balance if provided
    if (body.supplierId) {
      const cost = new Prisma.Decimal(body.purchasePrice).times(body.qty);
      await tx.supplier.update({
        where: { id: body.supplierId },
        data: { balance: { increment: cost } },
      });
    }
    return tx.medicineBatch.findUnique({
      where: { id: batch.id },
      include: { medicine: true, branch: true, supplier: true },
    });
  });

  created(res, result, "Batch received");
};

/**
 * Adjust qty on a single batch (correction / wastage / expiry write-off).
 */
export const adjustBatch = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const userId = req.auth!.sub;
  const body = req.body as {
    batchId: string;
    delta: number;
    reason: "ADJUSTMENT" | "WASTAGE" | "EXPIRY" | "RETURN";
    notes?: string;
  };
  if (!body.batchId || body.delta == null) throw ApiError.badRequest("batchId and delta required");
  if (body.delta === 0) throw ApiError.badRequest("delta must be non-zero");

  const batch = await prisma.medicineBatch.findFirst({
    where: { id: body.batchId, tenantId },
  });
  if (!batch) throw ApiError.notFound("Batch not found");

  await prisma.$transaction(async (tx) => {
    await applyMovement(
      {
        tenantId,
        batchId: batch.id,
        delta: body.delta,
        reason: body.reason,
        createdById: userId,
        notes: body.notes,
      },
      tx
    );
  });

  ok(res, { ok: true }, "Stock adjusted");
};

/**
 * Movement history for a batch (audit log).
 */
export const movements = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const batchId = String(req.params.batchId);
  const rows = await prisma.stockMovement.findMany({
    where: { tenantId, batchId },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { createdBy: { select: { id: true, name: true } } },
  });
  ok(res, rows);
};

