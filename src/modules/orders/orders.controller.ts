import { Request, Response } from "express";
import { prisma } from "../../config/db";
import { ok, created, paginate } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import { getPagination } from "../../utils/pagination";
import { barcode, orderNumber, qrToken } from "../../utils/codes";
import { createInvoice } from "../../utils/invoiceBuilder";
import dayjs from "dayjs";
import { Prisma } from "@prisma/client";

interface CreateOrderBody {
  patientId: string;
  branchId?: string;
  admissionId?: string;
  referralDoctor?: string;
  referrerUserId?: string;
  referrerId?: string;
  commissionPercent?: number;
  isHomeCollection?: boolean;
  homeAddress?: string;
  notes?: string;
  items: { testId: string; price?: number }[];
  discountAmount?: number;
  discountReason?: string;
  vatPercent?: number;
  initialPayment?: {
    amount: number;
    method: "CASH" | "BKASH" | "NAGAD" | "ROCKET" | "CARD" | "BANK_TRANSFER";
    referenceNo?: string;
    notes?: string;
  };
}

export const list = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const { page, pageSize, skip, take } = getPagination(req);
  const status = req.query.status as string | undefined;
  const branchId = req.query.branchId as string | undefined;
  const q = (req.query.q as string | undefined)?.trim();

  const where: Prisma.TestOrderWhereInput = {
    tenantId,
    ...(branchId ? { branchId } : {}),
    ...(status ? { status: status as Prisma.TestOrderWhereInput["status"] } : {}),
    ...(q
      ? {
          OR: [
            { orderNumber: { contains: q, mode: "insensitive" } },
            { patient: { name: { contains: q, mode: "insensitive" } } },
            { patient: { phone: { contains: q } } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.testOrder.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take,
      include: {
        patient: { select: { id: true, name: true, patientCode: true, phone: true } },
        branch: { select: { name: true } },
        items: {
          select: { id: true, status: true, test: { select: { nameEn: true, code: true } } },
        },
        invoice: { select: { id: true, invoiceNumber: true, totalAmount: true, status: true } },
      },
    }),
    prisma.testOrder.count({ where }),
  ]);
  ok(res, rows, "OK", paginate(page, pageSize, total));
};

export const labQueue = async (req: Request, res: Response) => {
  const rows = await prisma.testOrderItem.findMany({
    where: {
      order: { tenantId: req.auth!.tenantId },
      status: { in: ["PENDING", "SAMPLE_COLLECTED", "IN_LAB", "PROCESSING"] },
    },
    orderBy: { createdAt: "asc" },
    include: {
      test: { select: { id: true, nameEn: true, code: true, sampleType: true } },
      order: {
        select: {
          id: true,
          orderNumber: true,
          createdAt: true,
          patient: { select: { id: true, name: true, patientCode: true, gender: true, dob: true } },
          branch: { select: { name: true } },
        },
      },
      report: { select: { id: true, status: true } },
    },
  });
  ok(res, rows);
};

export const getOne = async (req: Request, res: Response) => {
  const order = await prisma.testOrder.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId },
    include: {
      patient: true,
      branch: true,
      orderedBy: { select: { id: true, name: true } },
      referrerUser: { select: { id: true, name: true, designation: true, bmdcNumber: true } },
      referrer: { select: { id: true, name: true, designation: true, hospital: true, phone: true } },
      invoice: { include: { payments: { include: { collectedBy: { select: { name: true } } } } } },
      items: {
        include: {
          test: { select: { nameEn: true, code: true, sampleType: true, basePrice: true } },
          report: { select: { id: true, status: true, isAbnormal: true } },
        },
      },
    },
  });
  if (!order) throw ApiError.notFound("Order not found");
  ok(res, order);
};

export const create = async (req: Request, res: Response) => {
  const body = req.body as CreateOrderBody;
  const { tenantId, sub: userId, branchId: userBranchId } = req.auth!;
  const branchId = body.branchId ?? userBranchId;
  if (!branchId) throw ApiError.badRequest("branchId required (assign user to a branch)");

  const patient = await prisma.patient.findFirst({
    where: { id: body.patientId, tenantId, deletedAt: null },
  });
  if (!patient) throw ApiError.notFound("Patient not found");

  // Inpatient billing path — verify the admission belongs to this patient.
  // Charges roll into the IPD discharge bill; no standalone invoice created.
  if (body.admissionId) {
    const a = await prisma.admission.findFirst({
      where: { id: body.admissionId, tenantId, status: "ADMITTED" },
      select: { id: true, patientId: true },
    });
    if (!a) throw ApiError.badRequest("Active admission not found");
    if (a.patientId !== patient.id) {
      throw ApiError.badRequest("Admission's patient does not match");
    }
  }

  const tests = await prisma.test.findMany({
    where: { tenantId, id: { in: body.items.map((i) => i.testId) }, isActive: true },
    include: { branchPrices: { where: { branchId } } },
  });
  if (tests.length !== body.items.length) throw ApiError.badRequest("Some tests are invalid");

  const today = dayjs().startOf("day").toDate();
  const orderSeq = await prisma.testOrder.count({
    where: { tenantId, createdAt: { gte: today } },
  });

  const items = body.items.map((line) => {
    const test = tests.find((t) => t.id === line.testId)!;
    const branchPrice = test.branchPrices[0]?.price;
    const price =
      line.price != null
        ? new Prisma.Decimal(line.price)
        : branchPrice ?? test.basePrice;
    return { testId: test.id, price, barcode: barcode() };
  });

  const subtotal = items.reduce(
    (sum, i) => sum.plus(i.price),
    new Prisma.Decimal(0)
  );

  // Resolve referrer + commission. Falls back to referrer's default % if not provided.
  let referrerUserId: string | null = null;
  let referrerId: string | null = null;
  let commissionPercent: Prisma.Decimal | null = null;
  if (body.referrerUserId) {
    const u = await prisma.user.findFirst({
      where: { id: body.referrerUserId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!u) throw ApiError.badRequest("Referrer user not found");
    referrerUserId = u.id;
    commissionPercent =
      body.commissionPercent != null
        ? new Prisma.Decimal(body.commissionPercent)
        : new Prisma.Decimal(0);
  } else if (body.referrerId) {
    const r = await prisma.referrer.findFirst({
      where: { id: body.referrerId, tenantId, deletedAt: null },
      select: { id: true, defaultCommissionPercent: true },
    });
    if (!r) throw ApiError.badRequest("Referrer not found");
    referrerId = r.id;
    commissionPercent =
      body.commissionPercent != null
        ? new Prisma.Decimal(body.commissionPercent)
        : r.defaultCommissionPercent;
  }
  const commissionAmount = commissionPercent
    ? subtotal.times(commissionPercent).dividedBy(100)
    : null;

  const result = await prisma.$transaction(async (tx) => {
    // Create the order + items first so we have item IDs to reference from invoice lines.
    const order = await tx.testOrder.create({
      data: {
        tenantId,
        branchId,
        patientId: patient.id,
        orderedById: userId,
        orderNumber: orderNumber(orderSeq + 1),
        referralDoctor: body.referralDoctor ?? null,
        referrerUserId,
        referrerId,
        commissionPercent,
        commissionAmount,
        isHomeCollection: body.isHomeCollection ?? false,
        homeAddress: body.homeAddress ?? null,
        notes: body.notes ?? null,
        status: "PENDING",
        items: { create: items },
      },
      include: { items: { include: { test: { select: { nameEn: true } } } } },
    });

    // Build invoice lines from the created items so refId points at the real row.
    let invoice: Awaited<ReturnType<typeof createInvoice>> | null = null;

    if (body.admissionId) {
      // Inpatient — write IpdCharge per item, no standalone invoice.
      for (const it of order.items) {
        const priceNum = Number(it.price);
        await tx.ipdCharge.create({
          data: {
            tenantId,
            admissionId: body.admissionId,
            chargeDate: dayjs().startOf("day").toDate(),
            chargeType: "INVESTIGATION",
            description: it.test.nameEn,
            qty: 1,
            unitPrice: new Prisma.Decimal(priceNum),
            amount: new Prisma.Decimal(priceNum),
            refTable: "test_order_items",
            refId: it.id,
            createdById: userId,
          },
        });
      }
    } else {
      invoice = await createInvoice(
        {
          tenantId,
          branchId,
          patientId: patient.id,
          kind: "DIAGNOSTIC",
          discountAmount: body.discountAmount,
          discountReason: body.discountReason,
          vatPercent: body.vatPercent,
          collectedById: userId,
          initialPayment: body.initialPayment,
          lines: order.items.map((it) => ({
            lineType: "TEST" as const,
            description: it.test.nameEn,
            unitPrice: Number(it.price),
            qty: 1,
            refTable: "test_order_items",
            refId: it.id,
          })),
        },
        tx
      );

      await tx.testOrder.update({
        where: { id: order.id },
        data: { invoiceId: invoice.id },
      });
    }

    // Pre-create draft reports for each item so labs can pick them up.
    await tx.report.createMany({
      data: order.items.map((it) => ({
        tenantId,
        orderId: order.id,
        orderItemId: it.id,
        status: "DRAFT" as const,
        qrToken: qrToken(),
      })),
    });

    return { order: { ...order, invoiceId: invoice?.id ?? null }, invoice };
  });

  created(res, result, "Order created");
};

export const updateItemStatus = async (req: Request, res: Response) => {
  const { status } = req.body as { status: "PENDING" | "SAMPLE_COLLECTED" | "IN_LAB" | "PROCESSING" | "COMPLETED" | "DELIVERED" | "CANCELLED" };

  const item = await prisma.testOrderItem.findFirst({
    where: { id: String(req.params.itemId), order: { tenantId: req.auth!.tenantId } },
    include: { order: true },
  });
  if (!item) throw ApiError.notFound("Order item not found");

  const updated = await prisma.testOrderItem.update({
    where: { id: item.id },
    data: {
      status,
      sampleCollectedAt:
        status === "SAMPLE_COLLECTED" && !item.sampleCollectedAt ? new Date() : undefined,
    },
  });

  // Roll up order status
  const items = await prisma.testOrderItem.findMany({ where: { orderId: item.orderId } });
  const allDone = items.every((i) => i.status === "COMPLETED" || i.status === "DELIVERED");
  const anyStarted = items.some(
    (i) => i.status !== "PENDING" && i.status !== "CANCELLED"
  );
  await prisma.testOrder.update({
    where: { id: item.orderId },
    data: { status: allDone ? "COMPLETED" : anyStarted ? "PROCESSING" : "PENDING" },
  });

  ok(res, updated, "Status updated");
};

