import { Request, Response } from "express";
import { Prisma, CorporateStatementStatus, InvoiceStatus, PaymentMethod } from "@prisma/client";
import dayjs from "dayjs";
import { prisma } from "../../config/db";
import { ok, created, paginate } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import { getPagination } from "../../utils/pagination";

const D = (n: number | string | Prisma.Decimal) => new Prisma.Decimal(n);
const num = (v: Prisma.Decimal | number | string | null | undefined) => (v == null ? 0 : Number(v));

// ─── Corporate clients ────────────────────────────────────────

export const listClients = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const { page, pageSize, skip, take } = getPagination(req);
  const q = (req.query.q as string | undefined)?.trim();
  const activeOnly = req.query.activeOnly === "true";
  const type = req.query.type as string | undefined;

  const where: Prisma.CorporateClientWhereInput = {
    tenantId,
    deletedAt: null,
    ...(activeOnly ? { isActive: true } : {}),
    ...(type ? { type: type as any } : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { phone: { contains: q } },
            { email: { contains: q, mode: "insensitive" } },
            { taxId: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.corporateClient.findMany({
      where,
      orderBy: { name: "asc" },
      skip,
      take,
      include: { _count: { select: { patients: true, statements: true } } },
    }),
    prisma.corporateClient.count({ where }),
  ]);
  ok(res, rows, "OK", paginate(page, pageSize, total));
};

export const getClient = async (req: Request, res: Response) => {
  const c = await prisma.corporateClient.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId, deletedAt: null },
    include: {
      _count: { select: { patients: true, statements: true } },
    },
  });
  if (!c) throw ApiError.notFound("Corporate client not found");

  const [openStmt, openCount] = await Promise.all([
    prisma.corporateStatement.aggregate({
      where: {
        tenantId: req.auth!.tenantId,
        clientId: c.id,
        status: { in: ["OPEN", "GENERATED", "PARTIALLY_PAID"] },
      },
      _sum: { dueAmount: true },
    }),
    prisma.corporateStatement.count({
      where: {
        tenantId: req.auth!.tenantId,
        clientId: c.id,
        status: { in: ["OPEN", "GENERATED", "PARTIALLY_PAID"] },
      },
    }),
  ]);

  ok(res, {
    ...c,
    outstandingTotal: num(openStmt._sum.dueAmount),
    outstandingCount: openCount,
  });
};

export const createClient = async (req: Request, res: Response) => {
  const body = req.body as Record<string, any>;
  const discount = Number(body.discountPercent ?? 0);
  if (discount < 0 || discount > 100) {
    throw ApiError.badRequest("discountPercent must be between 0 and 100");
  }
  const c = await prisma.corporateClient.create({
    data: {
      tenantId: req.auth!.tenantId,
      name: String(body.name).trim(),
      type: (body.type as any) || "COMPANY",
      contactPerson: body.contactPerson || null,
      phone: body.phone || null,
      email: body.email || null,
      address: body.address || null,
      taxId: body.taxId || null,
      discountPercent: D(discount),
      creditLimit: D(body.creditLimit ?? 0),
      paymentTermsDays: Number(body.paymentTermsDays ?? 30),
      notes: body.notes || null,
      isActive: body.isActive ?? true,
    },
  });
  created(res, c, "Corporate client added");
};

export const updateClient = async (req: Request, res: Response) => {
  const c = await prisma.corporateClient.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId, deletedAt: null },
  });
  if (!c) throw ApiError.notFound("Corporate client not found");

  const body = req.body as Record<string, any>;
  if (body.discountPercent !== undefined) {
    const d = Number(body.discountPercent);
    if (d < 0 || d > 100) throw ApiError.badRequest("discountPercent must be between 0 and 100");
  }

  const updated = await prisma.corporateClient.update({
    where: { id: c.id },
    data: {
      name: body.name !== undefined ? String(body.name).trim() : undefined,
      type: body.type ?? undefined,
      contactPerson: body.contactPerson !== undefined ? (body.contactPerson || null) : undefined,
      phone: body.phone !== undefined ? (body.phone || null) : undefined,
      email: body.email !== undefined ? (body.email || null) : undefined,
      address: body.address !== undefined ? (body.address || null) : undefined,
      taxId: body.taxId !== undefined ? (body.taxId || null) : undefined,
      discountPercent: body.discountPercent !== undefined ? D(body.discountPercent) : undefined,
      creditLimit: body.creditLimit !== undefined ? D(body.creditLimit) : undefined,
      paymentTermsDays: body.paymentTermsDays !== undefined ? Number(body.paymentTermsDays) : undefined,
      notes: body.notes !== undefined ? (body.notes || null) : undefined,
      isActive: body.isActive ?? undefined,
    },
  });
  ok(res, updated, "Corporate client updated");
};

export const removeClient = async (req: Request, res: Response) => {
  const c = await prisma.corporateClient.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId, deletedAt: null },
  });
  if (!c) throw ApiError.notFound("Corporate client not found");

  const openStmt = await prisma.corporateStatement.count({
    where: { clientId: c.id, status: { in: ["OPEN", "GENERATED", "PARTIALLY_PAID"] } },
  });
  if (openStmt > 0) throw ApiError.conflict("Cannot delete: open or unpaid statements exist");

  await prisma.corporateClient.update({
    where: { id: c.id },
    data: { deletedAt: new Date(), isActive: false },
  });
  ok(res, { ok: true }, "Corporate client deleted");
};

// Patients linked to a corporate client
export const listClientPatients = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const { page, pageSize, skip, take } = getPagination(req);

  const client = await prisma.corporateClient.findFirst({
    where: { id: String(req.params.id), tenantId, deletedAt: null },
    select: { id: true },
  });
  if (!client) throw ApiError.notFound("Corporate client not found");

  const where: Prisma.PatientWhereInput = {
    tenantId,
    deletedAt: null,
    corporateClientId: client.id,
  };
  const [rows, total] = await Promise.all([
    prisma.patient.findMany({
      where,
      orderBy: { name: "asc" },
      skip,
      take,
      select: {
        id: true,
        patientCode: true,
        name: true,
        phone: true,
        gender: true,
        corporateEmpId: true,
        createdAt: true,
      },
    }),
    prisma.patient.count({ where }),
  ]);
  ok(res, rows, "OK", paginate(page, pageSize, total));
};

// ─── Statements ───────────────────────────────────────────────

// Per-tenant monotonic statement number — uses a dated prefix and counts
// existing statements that day. Conflicts are extremely unlikely (per-tenant
// + per-day), but we retry once if Prisma raises a unique-violation.
const nextStatementNumber = async (tenantId: string): Promise<string> => {
  const prefix = `CST-${dayjs().format("YYMMDD")}-`;
  const last = await prisma.corporateStatement.findFirst({
    where: { tenantId, statementNumber: { startsWith: prefix } },
    orderBy: { statementNumber: "desc" },
    select: { statementNumber: true },
  });
  const seq = last ? Number(last.statementNumber.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(seq).padStart(4, "0")}`;
};

export const listAllStatements = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const { page, pageSize, skip, take } = getPagination(req);
  const status = req.query.status as string | undefined;
  const clientId = req.query.clientId as string | undefined;

  const where: Prisma.CorporateStatementWhereInput = {
    tenantId,
    ...(status ? { status: status as any } : {}),
    ...(clientId ? { clientId } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.corporateStatement.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take,
      include: { client: { select: { id: true, name: true, type: true } } },
    }),
    prisma.corporateStatement.count({ where }),
  ]);
  ok(res, rows, "OK", paginate(page, pageSize, total));
};

export const listClientStatements = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const { page, pageSize, skip, take } = getPagination(req);

  const client = await prisma.corporateClient.findFirst({
    where: { id: String(req.params.id), tenantId, deletedAt: null },
    select: { id: true },
  });
  if (!client) throw ApiError.notFound("Corporate client not found");

  const [rows, total] = await Promise.all([
    prisma.corporateStatement.findMany({
      where: { tenantId, clientId: client.id },
      orderBy: { periodFrom: "desc" },
      skip,
      take,
    }),
    prisma.corporateStatement.count({ where: { tenantId, clientId: client.id } }),
  ]);
  ok(res, rows, "OK", paginate(page, pageSize, total));
};

/**
 * Generate a new statement for a client over a date range.
 * Picks every invoice where:
 *   - invoice.patient.corporateClientId = client.id
 *   - invoice was created within [periodFrom, periodTo]
 *   - the invoice is not already on another non-cancelled statement
 *
 * Applies the client's discountPercent to the invoice subtotals. Result
 * is a DRAFT (status=GENERATED) statement; finalize() locks it.
 */
export const generateStatement = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const body = req.body as Record<string, any>;

  const client = await prisma.corporateClient.findFirst({
    where: { id: String(req.params.id), tenantId, deletedAt: null },
  });
  if (!client) throw ApiError.notFound("Corporate client not found");

  const periodFrom = dayjs(body.periodFrom).startOf("day");
  const periodTo = dayjs(body.periodTo).endOf("day");
  if (!periodFrom.isValid() || !periodTo.isValid()) throw ApiError.badRequest("Invalid period");
  if (periodFrom.isAfter(periodTo)) throw ApiError.badRequest("periodFrom must be on or before periodTo");

  // IDs already claimed by another active statement for this client.
  const existing = await prisma.corporateStatement.findMany({
    where: { tenantId, clientId: client.id, status: { not: "CANCELLED" } },
    select: { invoiceIds: true },
  });
  const claimed = new Set(existing.flatMap((s) => s.invoiceIds));

  const invoices = await prisma.invoice.findMany({
    where: {
      tenantId,
      patient: { corporateClientId: client.id },
      createdAt: { gte: periodFrom.toDate(), lte: periodTo.toDate() },
      status: { not: InvoiceStatus.CANCELLED },
    },
    select: { id: true, totalAmount: true, paidAmount: true },
  });
  const eligible = invoices.filter((i) => !claimed.has(i.id));
  if (eligible.length === 0) {
    throw ApiError.badRequest("No eligible invoices in this period (already on a statement, or none exist)");
  }

  const subtotal = eligible.reduce((sum, i) => sum.add(i.totalAmount), D(0));
  const discountAmount = subtotal.mul(client.discountPercent).div(100).toDecimalPlaces(2);
  const netPayable = subtotal.sub(discountAmount).toDecimalPlaces(2);

  const dueDate = client.paymentTermsDays > 0
    ? dayjs().add(client.paymentTermsDays, "day").toDate()
    : null;

  let statementNumber = await nextStatementNumber(tenantId);
  let stmt;
  try {
    stmt = await prisma.corporateStatement.create({
      data: {
        tenantId,
        clientId: client.id,
        statementNumber,
        periodFrom: periodFrom.toDate(),
        periodTo: periodTo.toDate(),
        invoiceIds: eligible.map((i) => i.id),
        subtotal,
        discountAmount,
        netPayable,
        dueAmount: netPayable,
        status: CorporateStatementStatus.GENERATED,
        dueDate,
        generatedAt: new Date(),
        notes: body.notes || null,
      },
      include: { client: { select: { id: true, name: true, type: true } } },
    });
  } catch (err: any) {
    if (err?.code === "P2002") {
      // unique-violation race — retry once with a fresh number
      statementNumber = await nextStatementNumber(tenantId);
      stmt = await prisma.corporateStatement.create({
        data: {
          tenantId,
          clientId: client.id,
          statementNumber,
          periodFrom: periodFrom.toDate(),
          periodTo: periodTo.toDate(),
          invoiceIds: eligible.map((i) => i.id),
          subtotal,
          discountAmount,
          netPayable,
          dueAmount: netPayable,
          status: CorporateStatementStatus.GENERATED,
          dueDate,
          generatedAt: new Date(),
          notes: body.notes || null,
        },
        include: { client: { select: { id: true, name: true, type: true } } },
      });
    } else {
      throw err;
    }
  }

  // Add to client running balance
  await prisma.corporateClient.update({
    where: { id: client.id },
    data: { balance: { increment: netPayable } },
  });

  created(res, stmt, "Statement generated");
};

export const getStatement = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const stmt = await prisma.corporateStatement.findFirst({
    where: { id: String(req.params.id), tenantId },
    include: {
      client: true,
      payments: { orderBy: { paidAt: "desc" } },
    },
  });
  if (!stmt) throw ApiError.notFound("Statement not found");

  // Fetch the underlying invoices snapshot so the UI can render line items
  const invoices = stmt.invoiceIds.length
    ? await prisma.invoice.findMany({
        where: { tenantId, id: { in: stmt.invoiceIds } },
        select: {
          id: true,
          invoiceNumber: true,
          totalAmount: true,
          paidAmount: true,
          createdAt: true,
          patient: { select: { id: true, name: true, patientCode: true, corporateEmpId: true } },
        },
        orderBy: { createdAt: "asc" },
      })
    : [];

  ok(res, { ...stmt, invoices });
};

export const recordStatementPayment = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const body = req.body as Record<string, any>;

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw ApiError.badRequest("amount must be > 0");

  const stmt = await prisma.corporateStatement.findFirst({
    where: { id: String(req.params.id), tenantId },
  });
  if (!stmt) throw ApiError.notFound("Statement not found");
  if (stmt.status === "CANCELLED") throw ApiError.badRequest("Statement is cancelled");
  if (stmt.status === "PAID") throw ApiError.badRequest("Statement is already paid");

  const dueBefore = stmt.dueAmount;
  if (D(amount).gt(dueBefore)) throw ApiError.badRequest(`Amount exceeds due (${num(dueBefore).toFixed(2)})`);

  const result = await prisma.$transaction(async (tx) => {
    const pay = await tx.corporatePayment.create({
      data: {
        tenantId,
        statementId: stmt.id,
        amount: D(amount),
        method: (body.method as PaymentMethod) || PaymentMethod.BANK_TRANSFER,
        referenceNo: body.referenceNo || null,
        notes: body.notes || null,
        receivedById: req.auth!.sub,
      },
    });

    const newPaid = stmt.paidAmount.add(amount);
    const newDue = stmt.netPayable.sub(newPaid);
    const newStatus: CorporateStatementStatus = newDue.lte(0)
      ? "PAID"
      : "PARTIALLY_PAID";

    const updated = await tx.corporateStatement.update({
      where: { id: stmt.id },
      data: {
        paidAmount: newPaid,
        dueAmount: newDue.lt(0) ? D(0) : newDue,
        status: newStatus,
        finalizedAt: newStatus === "PAID" ? new Date() : stmt.finalizedAt,
      },
    });

    await tx.corporateClient.update({
      where: { id: stmt.clientId },
      data: { balance: { decrement: amount } },
    });

    return { payment: pay, statement: updated };
  });

  created(res, result, "Payment recorded");
};

export const cancelStatement = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const stmt = await prisma.corporateStatement.findFirst({
    where: { id: String(req.params.id), tenantId },
  });
  if (!stmt) throw ApiError.notFound("Statement not found");
  if (stmt.status === "PAID") throw ApiError.badRequest("Cannot cancel a fully paid statement");
  if (stmt.paidAmount.gt(0)) throw ApiError.badRequest("Cannot cancel a statement with payments — refund first");

  await prisma.$transaction(async (tx) => {
    await tx.corporateStatement.update({
      where: { id: stmt.id },
      data: { status: "CANCELLED" },
    });
    // Roll back the running balance we added at generation
    await tx.corporateClient.update({
      where: { id: stmt.clientId },
      data: { balance: { decrement: stmt.netPayable } },
    });
  });

  ok(res, { ok: true }, "Statement cancelled");
};

