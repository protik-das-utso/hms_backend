import { Request, Response } from "express";
import PDFDocument from "pdfkit";
import dayjs from "dayjs";
import { prisma } from "../../config/db";
import { ApiError } from "../../utils/ApiError";
import { env } from "../../config/env";

const C = {
  primary: "#1A5276",
  accent: "#16A085",
  text: "#1C1C1C",
  muted: "#666666",
  border: "#D5D8DC",
  borderDark: "#7B8A8B",
};
const PAGE = { left: 40, right: 555, top: 40, width: 515 };

/**
 * Discharge summary PDF — A4, single page in most cases. Matches the look
 * and feel of streamPrescriptionPdf / streamReportPdf without depending on
 * them so we don't have to widen the public surface of pdf.ts.
 */
export const downloadDischargeSummaryPdf = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const a = await prisma.admission.findFirst({
    where: { id: String(req.params.id), tenantId },
    include: {
      tenant: true,
      branch: true,
      patient: true,
      admittingDoctor: { select: { name: true, specialization: true, bmdcNumber: true } },
      allocations: { orderBy: { fromTs: "asc" }, include: { bed: { include: { ward: true } } } },
      dischargeSummary: { include: { dischargingDoctor: { select: { name: true, bmdcNumber: true, specialization: true, qualifications: true } } } },
      invoice: { select: { invoiceNumber: true, totalAmount: true, dueAmount: true } },
    },
  });
  if (!a) throw ApiError.notFound("Admission not found");
  if (!a.dischargeSummary) throw ApiError.badRequest("No discharge summary on file yet");

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="discharge-${a.admissionNumber}.pdf"`);

  const doc = new PDFDocument({ size: "A4", margin: 40 });
  doc.pipe(res);

  // Header strip
  doc.rect(PAGE.left, PAGE.top, PAGE.width, 50).fillAndStroke("#FFFFFF", C.borderDark);
  doc.fillColor(C.primary).font("Helvetica-Bold").fontSize(15).text(a.tenant.name, PAGE.left + 10, PAGE.top + 8);
  doc.font("Helvetica").fillColor(C.text).fontSize(8.5);
  const headerBits = [
    a.branch.name && `Branch: ${a.branch.name}`,
    a.tenant.address,
    a.tenant.contactPhone && `Hotline: ${a.tenant.contactPhone}`,
  ].filter(Boolean).join("  ·  ");
  doc.text(headerBits, PAGE.left + 10, PAGE.top + 26, { width: PAGE.width - 20 });

  // Title bar
  doc.y = PAGE.top + 60;
  doc.rect(PAGE.left, doc.y, PAGE.width, 22).fill(C.primary);
  doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(11).text("DISCHARGE SUMMARY", PAGE.left, doc.y + 6, { width: PAGE.width, align: "center" });
  doc.y += 30;

  // Two-column patient + admission info
  doc.fillColor(C.text).font("Helvetica").fontSize(9.5);
  const labelW = 90;
  const valueW = (PAGE.width / 2) - labelW - 4;
  let y = doc.y;
  const row = (l1: string, v1: string, l2: string, v2: string) => {
    doc.font("Helvetica-Bold").fillColor(C.muted).fontSize(8.5).text(l1, PAGE.left, y, { width: labelW });
    doc.font("Helvetica").fillColor(C.text).fontSize(9.5).text(v1, PAGE.left + labelW, y, { width: valueW });
    doc.font("Helvetica-Bold").fillColor(C.muted).fontSize(8.5).text(l2, PAGE.left + PAGE.width / 2, y, { width: labelW });
    doc.font("Helvetica").fillColor(C.text).fontSize(9.5).text(v2, PAGE.left + PAGE.width / 2 + labelW, y, { width: valueW });
    y += 14;
  };
  const age = a.patient.dob ? `${dayjs().diff(a.patient.dob, "year")} y` : "—";
  row("Patient", a.patient.name, "Admission #", a.admissionNumber);
  row("Patient ID", a.patient.patientCode, "Status", a.status);
  row("Age / Gender", `${age} / ${a.patient.gender ?? "—"}`, "Admitted", dayjs(a.admittedAt).format("DD MMM YYYY, hh:mm A"));
  row("Phone", a.patient.phone, "Discharged", a.dischargedAt ? dayjs(a.dischargedAt).format("DD MMM YYYY, hh:mm A") : "—");
  const lastAlloc = a.allocations[a.allocations.length - 1];
  row(
    "Bed",
    lastAlloc ? `${lastAlloc.bed.ward.name} · ${lastAlloc.bed.code}` : "—",
    "Stay (days)",
    a.dischargedAt
      ? String(Math.max(1, dayjs(a.dischargedAt).diff(a.admittedAt, "day") + 1))
      : "—"
  );
  row(
    "Admitting Dr.",
    `Dr. ${a.admittingDoctor.name}${a.admittingDoctor.specialization ? ` (${a.admittingDoctor.specialization})` : ""}`,
    "Final bill",
    a.invoice ? `${a.invoice.invoiceNumber}` : "—"
  );
  doc.y = y + 6;

  // Sections
  const section = (title: string, body?: string | null) => {
    doc.rect(PAGE.left, doc.y, PAGE.width, 16).fill(C.accent);
    doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(9).text(title, PAGE.left + 6, doc.y + 4);
    doc.y += 20;
    doc.fillColor(C.text).font("Helvetica").fontSize(10).text(body && body.trim() ? body : "—", PAGE.left + 4, doc.y, { width: PAGE.width - 8 });
    doc.y += 8;
  };

  section("Diagnosis on admission", a.diagnosisOnAdmission);
  section("Final diagnosis", a.dischargeSummary.finalDiagnosis);
  section("Treatment summary", a.dischargeSummary.treatmentSummary);
  section("Advice on discharge", a.dischargeSummary.dischargeAdvice);
  if (a.dischargeSummary.followUpDate) {
    doc.fillColor(C.text).font("Helvetica-Bold").fontSize(10).text(
      `Follow-up: ${dayjs(a.dischargeSummary.followUpDate).format("DD MMM YYYY")}`,
      PAGE.left,
      doc.y + 4
    );
    doc.y += 18;
  }

  // Signature
  doc.y = Math.max(doc.y, 700);
  doc.moveTo(PAGE.left + 300, doc.y).lineTo(PAGE.left + PAGE.width, doc.y).strokeColor(C.borderDark).lineWidth(0.5).stroke();
  doc.y += 4;
  doc.fillColor(C.text).font("Helvetica-Bold").fontSize(10).text(
    `Dr. ${a.dischargeSummary.dischargingDoctor.name}`,
    PAGE.left + 300,
    doc.y,
    { width: PAGE.width - 300, align: "right" }
  );
  doc.font("Helvetica").fillColor(C.muted).fontSize(8.5);
  const sigBits = [a.dischargeSummary.dischargingDoctor.qualifications, a.dischargeSummary.dischargingDoctor.specialization].filter(Boolean).join(" · ");
  if (sigBits) doc.text(sigBits, PAGE.left + 300, doc.y, { width: PAGE.width - 300, align: "right" });
  if (a.dischargeSummary.dischargingDoctor.bmdcNumber) {
    doc.text(`BMDC: ${a.dischargeSummary.dischargingDoctor.bmdcNumber}`, PAGE.left + 300, doc.y, { width: PAGE.width - 300, align: "right" });
  }

  // Footer
  doc.font("Helvetica").fillColor(C.muted).fontSize(7.5);
  doc.text(`Generated ${dayjs().format("DD MMM YYYY, hh:mm A")}`, PAGE.left, 810);
  doc.text(`Powered by ${env.appName}`, PAGE.left, 810, { width: PAGE.width, align: "right" });

  doc.end();
};

