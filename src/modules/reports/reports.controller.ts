import { Request, Response } from "express";
import dayjs from "dayjs";
import { prisma } from "../../config/db";
import { ok, paginate } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import { getPagination } from "../../utils/pagination";
import { streamReportPdf } from "../../utils/pdf";
import { notify, sendSmsAsync } from "../../utils/notify";
import { env } from "../../config/env";

export const list = async (req: Request, res: Response) => {
  const { page, pageSize, skip, take } = getPagination(req);
  const status = req.query.status as string | undefined;
  const patientId = req.query.patientId as string | undefined;

  const where = {
    tenantId: req.auth!.tenantId,
    ...(status ? { status: status as "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "PUBLISHED" } : {}),
    ...(patientId ? { order: { patientId } } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.report.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take,
      include: {
        orderItem: { include: { test: { select: { nameEn: true, code: true } } } },
        order: {
          select: {
            orderNumber: true,
            patient: { select: { id: true, name: true, patientCode: true } },
          },
        },
        doctor: { select: { name: true } },
      },
    }),
    prisma.report.count({ where }),
  ]);
  ok(res, rows, "OK", paginate(page, pageSize, total));
};

export const pendingApproval = async (req: Request, res: Response) => {
  const rows = await prisma.report.findMany({
    where: { tenantId: req.auth!.tenantId, status: "PENDING_APPROVAL" },
    orderBy: { submittedAt: "asc" },
    include: {
      orderItem: { include: { test: { select: { nameEn: true } } } },
      order: {
        select: {
          orderNumber: true,
          patient: { select: { id: true, name: true, patientCode: true, gender: true, dob: true } },
        },
      },
      technician: { select: { name: true } },
    },
  });
  ok(res, rows);
};

export const getOne = async (req: Request, res: Response) => {
  const r = await prisma.report.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId },
    include: {
      orderItem: { include: { test: true } },
      order: { include: { patient: true, branch: true } },
      technician: { select: { id: true, name: true } },
      doctor: { select: { id: true, name: true, bmdcNumber: true } },
    },
  });
  if (!r) throw ApiError.notFound("Report not found");
  ok(res, r);
};

export const update = async (req: Request, res: Response) => {
  const r = await prisma.report.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId },
  });
  if (!r) throw ApiError.notFound("Report not found");
  if (r.status === "APPROVED" || r.status === "PUBLISHED") {
    throw ApiError.badRequest("Cannot edit an approved report");
  }

  const body = req.body as {
    resultData?: Record<string, { value?: string; unit?: string; refRange?: string; flag?: string }>;
    conclusion?: string;
    isAbnormal?: boolean;
    attachmentUrls?: string[];
  };

  // Auto-detect abnormal from H/L flags if not explicitly set
  let isAbnormal = body.isAbnormal;
  if (isAbnormal == null && body.resultData) {
    isAbnormal = Object.values(body.resultData).some((v) => v.flag === "H" || v.flag === "L");
  }

  const updated = await prisma.report.update({
    where: { id: r.id },
    data: {
      resultData: body.resultData ?? undefined,
      conclusion: body.conclusion ?? undefined,
      isAbnormal: isAbnormal ?? undefined,
      attachmentUrls: body.attachmentUrls ?? undefined,
      technicianId: req.auth!.sub,
      status: r.status === "DRAFT" ? "DRAFT" : r.status,
    },
  });
  ok(res, updated, "Report updated");
};

export const submitForApproval = async (req: Request, res: Response) => {
  const r = await prisma.report.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId },
  });
  if (!r) throw ApiError.notFound("Report not found");
  if (r.status !== "DRAFT") throw ApiError.badRequest("Only draft reports can be submitted");

  const updated = await prisma.report.update({
    where: { id: r.id },
    data: {
      status: "PENDING_APPROVAL",
      submittedAt: new Date(),
      technicianId: r.technicianId ?? req.auth!.sub,
    },
  });
  ok(res, updated, "Submitted for doctor approval");
};

export const approve = async (req: Request, res: Response) => {
  const r = await prisma.report.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId },
    include: {
      order: { include: { patient: true } },
      orderItem: true,
    },
  });
  if (!r) throw ApiError.notFound("Report not found");
  if (r.status !== "PENDING_APPROVAL") throw ApiError.badRequest("Report not pending approval");

  const updated = await prisma.report.update({
    where: { id: r.id },
    data: {
      status: "APPROVED",
      approvedAt: new Date(),
      doctorId: req.auth!.sub,
    },
  });

  // Mark the order item completed too
  await prisma.testOrderItem.update({
    where: { id: r.orderItemId },
    data: { status: "COMPLETED" },
  });

  // Notify patient via editable template (fallback to inline body).
  if (r.order.patient.phone) {
    const haveTpl = await prisma.smsTemplate.findUnique({
      where: { tenantId_code: { tenantId: req.auth!.tenantId, code: "REPORT_READY" } },
    });
    if (haveTpl) {
      sendSmsAsync({
        tenantId: req.auth!.tenantId,
        code: "REPORT_READY",
        to: r.order.patient.phone,
        vars: {
          name: r.order.patient.name,
          orderNumber: r.order.orderNumber,
          trackUrl: `${env.publicBaseUrl}/track`,
        },
        relatedTo: "REPORT_READY",
      });
    } else {
      void notify({
        tenantId: req.auth!.tenantId,
        to: r.order.patient.phone,
        body: `Dear ${r.order.patient.name}, your report for order ${r.order.orderNumber} is ready. Visit the patient portal to view & download.`,
        relatedTo: "REPORT_READY",
      });
    }
  }

  ok(res, updated, "Report approved");
};

export const downloadPdf = async (req: Request, res: Response) => {
  const r = await prisma.report.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId },
    include: {
      order: {
        include: {
          patient: true,
          branch: true,
          orderedBy: { select: { name: true, designation: true } },
        },
      },
      orderItem: { include: { test: { include: { category: { select: { nameEn: true } } } } } },
      doctor: true,
      technician: true,
      tenant: true,
    },
  });
  if (!r) throw ApiError.notFound("Report not found");

  // Patients can only download their own
  if (req.auth!.role === "PATIENT" && r.order.patient.id !== req.auth!.sub) {
    throw ApiError.forbidden();
  }

  // Patients cannot download unless approved
  if (req.auth!.role === "PATIENT" && r.status !== "APPROVED" && r.status !== "PUBLISHED") {
    throw ApiError.forbidden("Report not yet available");
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
      tenantEmail: r.tenant.contactEmail,
      branchName: r.order.branch?.name,
      patientName: r.order.patient.name,
      patientCode: r.order.patient.patientCode,
      patientAge: age,
      patientGender: r.order.patient.gender,
      patientPhone: r.order.patient.phone,
      testName: r.orderItem.test.nameEn,
      testCode: r.orderItem.test.code,
      categoryName: r.orderItem.test.category?.nameEn,
      sampleType: r.orderItem.test.sampleType,
      orderNumber: r.order.orderNumber,
      collectedAt: r.orderItem.sampleCollectedAt,
      receivedAt: r.submittedAt,
      approvedAt: r.approvedAt,
      doctorName: r.doctor?.name,
      doctorBmdc: r.doctor?.bmdcNumber,
      doctorQualifications: r.doctor?.qualifications,
      technicianName: r.technician?.name,
      referredBy: r.order.orderedBy?.name,
      resultData: r.resultData as Record<string, { value?: string; unit?: string; refRange?: string; flag?: string }> | undefined,
      conclusion: r.conclusion,
      attachmentUrls: r.attachmentUrls,
      qrToken: r.qrToken,
    },
    res
  );
};

