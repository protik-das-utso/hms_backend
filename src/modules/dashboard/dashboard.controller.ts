import { Request, Response } from "express";
import dayjs from "dayjs";
import { Prisma } from "@prisma/client";
import { prisma } from "../../config/db";
import { ok } from "../../utils/apiResponse";
import { cached } from "../../utils/cache";

const numeric = (v: Prisma.Decimal | number | string | null | undefined) =>
  v == null ? 0 : Number(v);

/**
 * Cached 60s per tenant — most staff refresh the dashboard several times an
 * hour, so one DB roundtrip per minute per tenant serves an entire clinic.
 * Newly-entered patients/payments may take up to a minute to reflect in the
 * KPIs, which is acceptable for at-a-glance dashboards.
 */
export const summary = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const payload = await cached(`dashboard:summary:${tenantId}`, 60_000, async () => {
    const todayStart = dayjs().startOf("day").toDate();
    const monthStart = dayjs().startOf("month").toDate();

    const [
      totalPatients,
      todayPatients,
      pendingOrders,
      pendingReports,
      todayRevenue,
      monthRevenue,
      duePayments,
      activeBranches,
    ] = await Promise.all([
      prisma.patient.count({ where: { tenantId, deletedAt: null } }),
      prisma.patient.count({ where: { tenantId, deletedAt: null, createdAt: { gte: todayStart } } }),
      prisma.testOrder.count({
        where: { tenantId, status: { in: ["PENDING", "SAMPLE_COLLECTED", "IN_LAB", "PROCESSING"] } },
      }),
      prisma.report.count({
        where: { tenantId, status: { in: ["DRAFT", "PENDING_APPROVAL"] } },
      }),
      prisma.payment.aggregate({
        where: { tenantId, paidAt: { gte: todayStart } },
        _sum: { amount: true },
      }),
      prisma.payment.aggregate({
        where: { tenantId, paidAt: { gte: monthStart } },
        _sum: { amount: true },
      }),
      prisma.invoice.aggregate({
        where: { tenantId, status: { in: ["ISSUED", "PARTIALLY_PAID"] } },
        _sum: { dueAmount: true },
      }),
      prisma.branch.count({ where: { tenantId, isActive: true } }),
    ]);

    return {
      totalPatients,
      todayPatients,
      pendingOrders,
      pendingReports,
      todayRevenue: Number(todayRevenue._sum.amount ?? 0),
      monthRevenue: Number(monthRevenue._sum.amount ?? 0),
      outstandingDue: Number(duePayments._sum.dueAmount ?? 0),
      activeBranches,
    };
  });
  ok(res, payload);
};

export const revenueTrend = async (req: Request, res: Response) => {
  const days = Math.min(60, parseInt((req.query.days as string) ?? "14", 10));
  const start = dayjs().subtract(days - 1, "day").startOf("day").toDate();

  const payments = await prisma.payment.findMany({
    where: { tenantId: req.auth!.tenantId, paidAt: { gte: start } },
    select: { amount: true, paidAt: true },
  });

  const map = new Map<string, number>();
  for (let i = 0; i < days; i++) {
    const key = dayjs(start).add(i, "day").format("YYYY-MM-DD");
    map.set(key, 0);
  }
  payments.forEach((p) => {
    const k = dayjs(p.paidAt).format("YYYY-MM-DD");
    map.set(k, (map.get(k) ?? 0) + Number(p.amount));
  });

  ok(res, Array.from(map.entries()).map(([date, amount]) => ({ date, amount })));
};

export const topTests = async (req: Request, res: Response) => {
  const monthStart = dayjs().startOf("month").toDate();
  const rows = await prisma.testOrderItem.groupBy({
    by: ["testId"],
    where: {
      order: { tenantId: req.auth!.tenantId, createdAt: { gte: monthStart } },
    },
    _count: { _all: true },
    orderBy: { _count: { testId: "desc" } },
    take: 5,
  });
  const tests = await prisma.test.findMany({
    where: { id: { in: rows.map((r) => r.testId) } },
    select: { id: true, nameEn: true, nameBn: true, code: true },
  });
  const out = rows.map((r) => {
    const t = tests.find((x) => x.id === r.testId);
    return { test: t, count: r._count._all };
  });
  ok(res, out);
};

export const recentOrders = async (req: Request, res: Response) => {
  const rows = await prisma.testOrder.findMany({
    where: { tenantId: req.auth!.tenantId },
    orderBy: { createdAt: "desc" },
    take: 8,
    include: {
      patient: { select: { name: true, patientCode: true } },
      items: { select: { id: true } },
      invoice: { select: { totalAmount: true, status: true } },
    },
  });
  ok(res, rows);
};

// ─── Super-admin overview ─────────────────────────────────────────────
//
// Aggregates KPIs across modules. Filtered by an optional branchId query
// param so a multi-branch tenant can see total or per-branch numbers.

const parseRange = (req: Request) => {
  const from = req.query.from ? dayjs(req.query.from as string).startOf("day").toDate() : dayjs().startOf("month").toDate();
  const to = req.query.to ? dayjs(req.query.to as string).endOf("day").toDate() : dayjs().endOf("day").toDate();
  return { from, to };
};

export const overview = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const branchId = req.query.branchId as string | undefined;
  const todayStart = dayjs().startOf("day").toDate();
  const monthStart = dayjs().startOf("month").toDate();
  const yearStart = dayjs().startOf("year").toDate();

  const branchFilter = branchId ? { branchId } : {};
  const invoiceBranchFilter: Prisma.InvoiceWhereInput = branchId ? { branchId } : {};
  const expenseBranchFilter = branchId ? { branchId } : {};

  const [
    todayPay, monthPay, yearPay,
    outstanding,
    newPatTodayCount, newPatMonthCount,
    activeAdmissions, totalBeds, occupiedBeds,
    pendingReports, pendingApproval,
    monthExpenseAgg,
    revenueByKind,
    paymentMix,
    branchSummary,
    appointmentsToday,
    branchRevenue,
  ] = await Promise.all([
    prisma.payment.aggregate({
      where: { tenantId, paidAt: { gte: todayStart }, invoice: invoiceBranchFilter },
      _sum: { amount: true },
    }),
    prisma.payment.aggregate({
      where: { tenantId, paidAt: { gte: monthStart }, invoice: invoiceBranchFilter },
      _sum: { amount: true },
    }),
    prisma.payment.aggregate({
      where: { tenantId, paidAt: { gte: yearStart }, invoice: invoiceBranchFilter },
      _sum: { amount: true },
    }),
    prisma.invoice.aggregate({
      where: { tenantId, ...invoiceBranchFilter, status: { in: ["ISSUED", "PARTIALLY_PAID"] } },
      _sum: { dueAmount: true },
      _count: { _all: true },
    }),
    prisma.patient.count({ where: { tenantId, deletedAt: null, createdAt: { gte: todayStart }, ...branchFilter } }),
    prisma.patient.count({ where: { tenantId, deletedAt: null, createdAt: { gte: monthStart }, ...branchFilter } }),
    prisma.admission.count({ where: { tenantId, status: "ADMITTED", ...branchFilter } }),
    prisma.bed.count({ where: { tenantId, deletedAt: null, ...(branchId ? { ward: { branchId } } : {}) } }),
    prisma.bed.count({ where: { tenantId, deletedAt: null, status: "OCCUPIED", ...(branchId ? { ward: { branchId } } : {}) } }),
    prisma.report.count({ where: { tenantId, status: "DRAFT" } }),
    prisma.report.count({ where: { tenantId, status: "PENDING_APPROVAL" } }),
    prisma.expense.aggregate({
      where: { tenantId, deletedAt: null, spentOn: { gte: monthStart }, ...expenseBranchFilter },
      _sum: { amount: true },
    }),
    prisma.invoice.groupBy({
      by: ["kind"],
      where: { tenantId, ...invoiceBranchFilter, createdAt: { gte: monthStart } },
      _sum: { totalAmount: true },
      _count: { _all: true },
    }),
    prisma.payment.groupBy({
      by: ["method"],
      where: { tenantId, paidAt: { gte: monthStart }, invoice: invoiceBranchFilter },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    // Branch-level summary for the current month.
    prisma.branch.findMany({
      where: { tenantId, isActive: true },
      select: {
        id: true,
        name: true,
        _count: {
          select: {
            invoices: { where: { createdAt: { gte: monthStart } } },
            patients: { where: { createdAt: { gte: monthStart }, deletedAt: null } },
          },
        },
      },
    }),
    prisma.appointment.count({
      where: {
        tenantId,
        ...branchFilter,
        slotStart: { gte: todayStart, lte: dayjs().endOf("day").toDate() },
        status: { notIn: ["CANCELLED", "NO_SHOW"] },
      },
    }),
    prisma.invoice.groupBy({
      by: ["branchId"],
      where: { tenantId, createdAt: { gte: monthStart } },
      _sum: { totalAmount: true, paidAmount: true },
    }),
  ]);

  const monthRevenue = numeric(monthPay._sum.amount);
  const monthExpense = numeric(monthExpenseAgg._sum.amount);

  ok(res, {
    range: { todayStart, monthStart, yearStart },
    kpis: {
      revenueToday: numeric(todayPay._sum.amount),
      revenueMonth: monthRevenue,
      revenueYear: numeric(yearPay._sum.amount),
      expenseMonth: monthExpense,
      netMonth: monthRevenue - monthExpense,
      outstandingDue: numeric(outstanding._sum.dueAmount),
      outstandingInvoiceCount: outstanding._count._all,
      newPatientsToday: newPatTodayCount,
      newPatientsMonth: newPatMonthCount,
      appointmentsToday,
      activeAdmissions,
      totalBeds,
      occupiedBeds,
      bedOccupancyPercent: totalBeds > 0 ? Math.round((occupiedBeds / totalBeds) * 100) : 0,
      pendingReports,
      pendingApproval,
    },
    revenueByKind: revenueByKind.map((r) => ({
      kind: r.kind,
      total: numeric(r._sum.totalAmount),
      count: r._count._all,
    })),
    paymentMix: paymentMix.map((p) => ({
      method: p.method,
      total: numeric(p._sum.amount),
      count: p._count._all,
    })),
    branches: branchSummary.map((b) => {
      const r = branchRevenue.find((x) => x.branchId === b.id);
      return {
        id: b.id,
        name: b.name,
        invoiceCount: b._count.invoices,
        newPatients: b._count.patients,
        revenue: numeric(r?._sum.totalAmount),
        collected: numeric(r?._sum.paidAmount),
      };
    }),
  });
};

export const topDoctors = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const { from, to } = parseRange(req);

  const visits = await prisma.doctorVisit.groupBy({
    by: ["doctorId"],
    where: { tenantId, visitAt: { gte: from, lte: to } },
    _sum: { fee: true },
    _count: { _all: true },
  });

  const consultations = await prisma.consultation.groupBy({
    by: ["doctorId"],
    where: { tenantId, createdAt: { gte: from, lte: to } },
    _count: { _all: true },
  });

  const doctorIds = Array.from(new Set([...visits.map((v) => v.doctorId), ...consultations.map((c) => c.doctorId)]));
  const doctors = await prisma.user.findMany({
    where: { id: { in: doctorIds }, tenantId, role: "DOCTOR" },
    select: { id: true, name: true, specialization: true, consultationFee: true },
  });

  const rows = doctors.map((d) => {
    const v = visits.find((x) => x.doctorId === d.id);
    const c = consultations.find((x) => x.doctorId === d.id);
    const ipdRevenue = numeric(v?._sum.fee);
    const consultRevenue = (c?._count._all ?? 0) * numeric(d.consultationFee);
    return {
      id: d.id,
      name: d.name,
      specialization: d.specialization,
      consultations: c?._count._all ?? 0,
      ipdVisits: v?._count._all ?? 0,
      ipdRevenue,
      consultRevenue,
      totalRevenue: ipdRevenue + consultRevenue,
    };
  });
  rows.sort((a, b) => b.totalRevenue - a.totalRevenue);
  ok(res, rows.slice(0, 10));
};

export const topMedicines = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const { from, to } = parseRange(req);

  const items = await prisma.pharmacySaleItem.findMany({
    where: {
      sale: { tenantId, createdAt: { gte: from, lte: to }, status: "COMPLETED" },
    },
    select: { medicineId: true, qty: true, unit: true, unitsPerBox: true, amount: true },
  });

  const agg = new Map<string, { qty: number; revenue: number }>();
  for (const it of items) {
    const cur = agg.get(it.medicineId) ?? { qty: 0, revenue: 0 };
    cur.qty += it.unit === "BOX" ? it.qty * it.unitsPerBox : it.qty;
    cur.revenue += numeric(it.amount);
    agg.set(it.medicineId, cur);
  }
  const top = Array.from(agg.entries())
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, 10);
  const medicines = await prisma.medicine.findMany({
    where: { id: { in: top.map((t) => t[0]) }, tenantId },
    select: { id: true, brandName: true, genericName: true, strength: true },
  });
  ok(res, top.map(([id, v]) => {
    const m = medicines.find((x) => x.id === id);
    return { medicine: m, piecesSold: v.qty, revenue: v.revenue };
  }));
};

export const outstandingTop = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const branchId = req.query.branchId as string | undefined;
  const rows = await prisma.invoice.findMany({
    where: {
      tenantId,
      ...(branchId ? { branchId } : {}),
      status: { in: ["ISSUED", "PARTIALLY_PAID"] },
      dueAmount: { gt: 0 },
    },
    orderBy: [{ dueAmount: "desc" }, { createdAt: "asc" }],
    take: 10,
    select: {
      id: true,
      invoiceNumber: true,
      kind: true,
      totalAmount: true,
      paidAmount: true,
      dueAmount: true,
      createdAt: true,
      patient: { select: { id: true, name: true, patientCode: true, phone: true } },
      branch: { select: { id: true, name: true } },
    },
  });
  ok(res, rows);
};

/**
 * All outstanding invoices for the dedicated dues report page. Supports
 * pagination + branch filter. Ordered by age (oldest first) so the
 * accountant works through the worst offenders first.
 */
export const outstandingAll = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const branchId = req.query.branchId as string | undefined;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize) || 50));

  const where: Prisma.InvoiceWhereInput = {
    tenantId,
    ...(branchId ? { branchId } : {}),
    status: { in: ["ISSUED", "PARTIALLY_PAID"] },
    dueAmount: { gt: 0 },
  };

  const [rows, total, agg] = await Promise.all([
    prisma.invoice.findMany({
      where,
      orderBy: [{ createdAt: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        invoiceNumber: true,
        kind: true,
        totalAmount: true,
        paidAmount: true,
        dueAmount: true,
        status: true,
        createdAt: true,
        patient: { select: { id: true, name: true, patientCode: true, phone: true } },
        branch: { select: { id: true, name: true } },
      },
    }),
    prisma.invoice.count({ where }),
    prisma.invoice.aggregate({ where, _sum: { dueAmount: true } }),
  ]);

  // Age buckets — 0–30 / 31–60 / 61–90 / 90+ days
  const now = Date.now();
  const buckets = { b30: 0, b60: 0, b90: 0, b90plus: 0 };
  // The same query without pagination would be ideal; we approximate by also
  // grouping the visible page. For an accurate aging, expose a separate
  // endpoint later — this is good enough for the dashboard summary.
  for (const r of rows) {
    const days = Math.floor((now - new Date(r.createdAt).getTime()) / (24 * 3600 * 1000));
    const due = numeric(r.dueAmount);
    if (days <= 30) buckets.b30 += due;
    else if (days <= 60) buckets.b60 += due;
    else if (days <= 90) buckets.b90 += due;
    else buckets.b90plus += due;
  }

  ok(res, {
    rows,
    page,
    pageSize,
    total,
    totalDue: numeric(agg._sum.dueAmount),
    ageBuckets: buckets,
  });
};

