import { Prisma, PrismaClient, StockMovementReason } from "@prisma/client";
import { prisma as defaultPrisma } from "../config/db";

type Tx = Prisma.TransactionClient | PrismaClient;

export interface ApplyMovementInput {
  tenantId: string;
  batchId: string;
  delta: number; // signed: positive=in, negative=out
  reason: StockMovementReason;
  createdById: string;
  refTable?: string;
  refId?: string;
  notes?: string;
}

/**
 * Single chokepoint for stock changes. Writes a StockMovement row and
 * mutates the batch's cached qtyOnHand in the same transaction.
 *
 * Callers MUST pass a Prisma transaction client (tx) to ensure both
 * writes commit together.
 *
 * Atomicity: for negative deltas (SALE/EXPIRY/WASTAGE/ADJUSTMENT-down) we
 * use a conditional `updateMany` that only commits when the row's current
 * qtyOnHand is >= -delta. When 0 rows are affected we know stock was
 * insufficient and throw. This makes two concurrent sales of the last unit
 * cleanly fail one of them — the prior read-then-write pattern allowed both
 * to pass an in-memory check and drive qtyOnHand negative.
 */
export const applyMovement = async (input: ApplyMovementInput, tx: Tx = defaultPrisma) => {
  if (input.delta === 0) {
    throw new Error("applyMovement: delta must be non-zero");
  }

  // Tenant-ownership pre-check (cheap on indexed PK).
  const batch = await tx.medicineBatch.findUnique({
    where: { id: input.batchId },
    select: { id: true, tenantId: true },
  });
  if (!batch) throw new Error("applyMovement: batch not found");
  if (batch.tenantId !== input.tenantId) {
    throw new Error("applyMovement: tenant mismatch");
  }

  // Atomic conditional update — only commits if qtyOnHand + delta >= 0.
  const updateRes =
    input.delta < 0
      ? await tx.medicineBatch.updateMany({
          where: { id: input.batchId, qtyOnHand: { gte: -input.delta } },
          data: { qtyOnHand: { increment: input.delta } },
        })
      : await tx.medicineBatch.updateMany({
          where: { id: input.batchId },
          data: { qtyOnHand: { increment: input.delta } },
        });

  if (updateRes.count === 0) {
    throw new Error(
      `Not enough stock in batch ${input.batchId} (concurrent sale or short stock)`
    );
  }

  await tx.stockMovement.create({
    data: {
      tenantId: input.tenantId,
      batchId: input.batchId,
      delta: input.delta,
      reason: input.reason,
      refTable: input.refTable ?? null,
      refId: input.refId ?? null,
      notes: input.notes ?? null,
      createdById: input.createdById,
    },
  });
};

/**
 * Pick batches for a requested qty using FEFO (First-Expiry-First-Out).
 * Returns the slices to dispense from each batch.
 */
export interface FefoPick {
  batchId: string;
  qty: number;
  unitPrice: number;
  expiryDate: Date;
}

export const pickFefo = async (
  params: { tenantId: string; medicineId: string; branchId: string; qty: number },
  tx: Tx = defaultPrisma
): Promise<FefoPick[]> => {
  const batches = await tx.medicineBatch.findMany({
    where: {
      tenantId: params.tenantId,
      medicineId: params.medicineId,
      branchId: params.branchId,
      qtyOnHand: { gt: 0 },
      expiryDate: { gte: new Date() }, // skip expired
    },
    orderBy: { expiryDate: "asc" },
    include: { medicine: { select: { salePrice: true } } },
  });

  const picks: FefoPick[] = [];
  let remaining = params.qty;
  for (const b of batches) {
    if (remaining <= 0) break;
    const take = Math.min(b.qtyOnHand, remaining);
    picks.push({
      batchId: b.id,
      qty: take,
      unitPrice: Number(b.medicine.salePrice),
      expiryDate: b.expiryDate,
    });
    remaining -= take;
  }
  if (remaining > 0) {
    throw new Error(
      `Insufficient stock for medicine ${params.medicineId}: need ${params.qty}, available ${params.qty - remaining}`
    );
  }
  return picks;
};
