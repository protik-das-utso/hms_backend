import { Router } from "express";
import { OrderStatus, ReportStatus } from "@prisma/client";
import { prisma } from "../../config/db";
import { ok } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import { asyncHandler } from "../../utils/asyncHandler";
import { streamReportPdf } from "../../utils/pdf";
import { computeStage, STAGE_LABELS } from "../../utils/trackStage";
import dayjs from "dayjs";

interface TrackItem {
  id: string;
  status: OrderStatus;
  barcode: string | null;
  sampleCollectedAt: Date | null;
  test: { nameEn: string; code: string };
  report: { status: ReportStatus; submittedAt: Date | null; approvedAt: Date | null } | null;
}
interface TrackOrderGroup {
  orderNumber: string;
  items: TrackItem[];
}
interface TrackHeader {
  tenant: { name: string; slug: string };
  branch: { name: string } | null;
  patient: { name: string; patientCode: string };
  invoiceNumber?: string;
  invoiceStatus?: string;
  totalAmount?: number;
  paidAmount?: number;
  dueAmount?: number;
  createdAt?: Date;
}

export const publicRouter = Router();

// Public report verification by QR token — used by anyone scanning a report
publicRouter.get(
  "/verify/:qrToken",
  asyncHandler(async (req, res) => {
    const r = await prisma.report.findUnique({
      where: { qrToken: String(req.params.qrToken) },
      include: {
        order: {
          include: {
            patient: { select: { name: true, patientCode: true, gender: true, dob: true } },
            branch: { select: { name: true } },
          },
        },
        orderItem: { include: { test: { select: { nameEn: true, code: true } } } },
        doctor: { select: { name: true, bmdcNumber: true } },
        technician: { select: { name: true } },
        tenant: { select: { name: true, address: true, contactPhone: true } },
      },
    });
    if (!r || (r.status !== "APPROVED" && r.status !== "PUBLISHED")) {
      throw ApiError.notFound("Report not found or not yet approved");
    }
    // Mask patient name for privacy in public verification
    const masked = r.order.patient.name
      .split(" ")
      .map((p, i) => (i === 0 ? p : p[0] + "***"))
      .join(" ");

    ok(res, {
      verified: true,
      report: {
        orderNumber: r.order.orderNumber,
        testName: r.orderItem.test.nameEn,
        patientName: masked,
        patientCode: r.order.patient.patientCode,
        approvedAt: r.approvedAt,
        doctorName: r.doctor?.name,
        doctorBmdc: r.doctor?.bmdcNumber,
        clinic: r.tenant.name,
        clinicAddress: r.tenant.address,
        clinicPhone: r.tenant.contactPhone,
        branch: r.order.branch?.name,
        isAbnormal: r.isAbnormal,
      },
    });
  })
);

// Public PDF download by QR (read-only)
publicRouter.get(
  "/verify/:qrToken/pdf",
  asyncHandler(async (req, res) => {
    const r = await prisma.report.findUnique({
      where: { qrToken: String(req.params.qrToken) },
      include: {
        order: { include: { patient: true, branch: true } },
        orderItem: { include: { test: true } },
        doctor: true,
        technician: true,
        tenant: true,
      },
    });
    if (!r || (r.status !== "APPROVED" && r.status !== "PUBLISHED")) {
      throw ApiError.notFound("Report not available");
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="report-${r.order.orderNumber}.pdf"`
    );
    const age = r.order.patient.dob
      ? `${dayjs().diff(r.order.patient.dob, "year")} y`
      : undefined;
    await streamReportPdf(
      {
        tenantName: r.tenant.name,
        tenantAddress: r.tenant.address,
        tenantPhone: r.tenant.contactPhone,
        branchName: r.order.branch?.name,
        patientName: r.order.patient.name,
        patientCode: r.order.patient.patientCode,
        patientAge: age,
        patientGender: r.order.patient.gender,
        patientPhone: r.order.patient.phone,
        testName: r.orderItem.test.nameEn,
        orderNumber: r.order.orderNumber,
        collectedAt: r.orderItem.sampleCollectedAt,
        approvedAt: r.approvedAt,
        doctorName: r.doctor?.name,
        doctorBmdc: r.doctor?.bmdcNumber,
        technicianName: r.technician?.name,
        resultData: r.resultData as Record<string, { value?: string; unit?: string; refRange?: string; flag?: string }> | undefined,
        conclusion: r.conclusion,
        qrToken: r.qrToken,
      },
      res
    );
  })
);

// Track tests by order#, invoice#, or sample barcode — public, sanitized
publicRouter.get(
  "/track/:code",
  asyncHandler(async (req, res) => {
    const code = String(req.params.code).trim();
    if (!code) throw ApiError.badRequest("Tracking code required");

    // Try invoice number first → expand to all its orders
    const invoice = await prisma.invoice.findFirst({
      where: { invoiceNumber: code },
      select: {
        invoiceNumber: true,
        status: true,
        createdAt: true,
        totalAmount: true,
        paidAmount: true,
        dueAmount: true,
        tenant: { select: { name: true, slug: true } },
        branch: { select: { name: true } },
        patient: { select: { name: true, patientCode: true } },
        orders: {
          select: {
            orderNumber: true,
            items: {
              select: {
                id: true,
                status: true,
                barcode: true,
                sampleCollectedAt: true,
                test: { select: { nameEn: true, code: true } },
                report: {
                  select: { status: true, submittedAt: true, approvedAt: true },
                },
              },
            },
          },
        },
      },
    });

    let orderList: TrackOrderGroup[] = (invoice?.orders ?? []) as TrackOrderGroup[];
    let header: TrackHeader | null = null;

    if (invoice) {
      header = {
        tenant: invoice.tenant,
        branch: invoice.branch,
        patient: invoice.patient,
        invoiceNumber: invoice.invoiceNumber,
        invoiceStatus: invoice.status,
        totalAmount: Number(invoice.totalAmount),
        paidAmount: Number(invoice.paidAmount),
        dueAmount: Number(invoice.dueAmount),
        createdAt: invoice.createdAt,
      };
    } else {
      // Try order number
      const order = await prisma.testOrder.findFirst({
        where: { orderNumber: code },
        select: {
          orderNumber: true,
          createdAt: true,
          tenant: { select: { name: true, slug: true } },
          branch: { select: { name: true } },
          patient: { select: { name: true, patientCode: true } },
          items: {
            select: {
              id: true,
              status: true,
              barcode: true,
              sampleCollectedAt: true,
              test: { select: { nameEn: true, code: true } },
              report: {
                select: { status: true, submittedAt: true, approvedAt: true },
              },
            },
          },
        },
      });
      if (order) {
        header = {
          tenant: order.tenant,
          branch: order.branch,
          patient: order.patient,
          createdAt: order.createdAt,
        };
        orderList = [{ orderNumber: order.orderNumber, items: order.items }] as TrackOrderGroup[];
      } else {
        // Try sample barcode
        const item = await prisma.testOrderItem.findFirst({
          where: { barcode: code },
          select: {
            id: true,
            status: true,
            barcode: true,
            sampleCollectedAt: true,
            test: { select: { nameEn: true, code: true } },
            report: {
              select: { status: true, submittedAt: true, approvedAt: true },
            },
            order: {
              select: {
                orderNumber: true,
                createdAt: true,
                tenant: { select: { name: true, slug: true } },
                branch: { select: { name: true } },
                patient: { select: { name: true, patientCode: true } },
              },
            },
          },
        });
        if (item) {
          header = {
            tenant: item.order.tenant,
            branch: item.order.branch,
            patient: item.order.patient,
            createdAt: item.order.createdAt,
          };
          orderList = [{
            orderNumber: item.order.orderNumber,
            items: [{
              id: item.id,
              status: item.status,
              barcode: item.barcode,
              sampleCollectedAt: item.sampleCollectedAt,
              test: item.test,
              report: item.report,
            }],
          }] as TrackOrderGroup[];
        }
      }
    }

    if (!header) throw ApiError.notFound("No record found for this code");

    // Sanitize patient name
    const firstName = header.patient.name.split(" ")[0];

    const tests = orderList.flatMap((o) =>
      o.items.map((it) => {
        const rep = it.report;
        const stage = computeStage(it.status, rep?.status);
        return {
          orderNumber: o.orderNumber,
          testCode: it.test.code,
          testName: it.test.nameEn,
          barcode: it.barcode,
          stage,
          stageLabel: STAGE_LABELS[stage],
          timeline: {
            sampleCollectedAt: it.sampleCollectedAt,
            submittedAt: rep?.submittedAt ?? null,
            approvedAt: rep?.approvedAt ?? null,
          },
        };
      })
    );

    ok(res, {
      clinic: header.tenant,
      branch: header.branch,
      patient: { name: firstName, patientCode: header.patient.patientCode },
      invoice: header.invoiceNumber
        ? {
            invoiceNumber: header.invoiceNumber,
            status: header.invoiceStatus,
            totalAmount: header.totalAmount,
            paidAmount: header.paidAmount,
            dueAmount: header.dueAmount,
          }
        : null,
      createdAt: header.createdAt,
      tests,
    });
  })
);

// Discover clinic by slug (so patient portal knows clinic name/logo before login)
publicRouter.get(
  "/clinic/:slug",
  asyncHandler(async (req, res) => {
    const t = await prisma.tenant.findUnique({
      where: { slug: String(req.params.slug) },
      select: { id: true, name: true, slug: true, logoUrl: true, contactPhone: true, address: true, isActive: true },
    });
    if (!t || !t.isActive) throw ApiError.notFound("Clinic not found");
    ok(res, t);
  })
);

