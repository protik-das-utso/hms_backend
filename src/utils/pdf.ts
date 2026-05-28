import PDFDocument from "pdfkit";
import { Writable } from "stream";
import dayjs from "dayjs";
import path from "path";
import fs from "fs";
import { qrBuffer } from "./qr";
import { code128Buffer } from "./barcode";
import { env } from "../config/env";

// ─── Shared palette ───────────────────────────────────────────────
const C = {
  primary: "#1A5276",
  accent: "#16A085",
  text: "#1C1C1C",
  muted: "#666666",
  border: "#D5D8DC",
  borderDark: "#7B8A8B",
  red: "#C0392B",
  green: "#1E8449",
  amber: "#B7950B",
  zebra: "#F7F9FA",
};

const PAGE = { left: 40, right: 555, top: 40, bottom: 800, width: 515 };

// ─── REPORT ──────────────────────────────────────────────────────
export interface ReportPdfInput {
  tenantName: string;
  tenantAddress?: string | null;
  tenantPhone?: string | null;
  tenantEmail?: string | null;
  branchName?: string | null;

  patientName: string;
  patientCode: string;
  patientAge?: string;
  patientGender?: string | null;
  patientPhone?: string;

  testName: string;
  testCode?: string;
  categoryName?: string;
  orderNumber: string;
  collectedAt?: Date | null;
  receivedAt?: Date | null;
  approvedAt?: Date | null;
  doctorName?: string | null;
  doctorBmdc?: string | null;
  doctorQualifications?: string | null;
  technicianName?: string | null;
  referredBy?: string | null;
  sampleType?: string | null;

  resultData?: Record<string, { value?: string; unit?: string; refRange?: string; flag?: string }>;
  conclusion?: string | null;
  attachmentUrls?: string[]; // server-relative paths e.g. "/uploads/reports/xyz.jpg"
  qrToken: string;
}

export const streamReportPdf = async (input: ReportPdfInput, out: Writable) => {
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  doc.pipe(out);

  // Header block
  await drawClinicHeader(doc, {
    name: input.tenantName,
    address: input.tenantAddress,
    phone: input.tenantPhone,
    email: input.tenantEmail,
    branch: input.branchName,
  });

  // Section title
  doc.moveDown(0.4);
  drawSectionBar(doc, "LABORATORY SERVICES");

  // Patient + lab info two-column block with barcode top-right
  const barcode = await code128Buffer(input.orderNumber, { height: 14 });
  const infoTop = doc.y + 4;
  doc.image(barcode, PAGE.right - 170, infoTop, { width: 160 });

  doc.fillColor(C.text).font("Helvetica").fontSize(9);
  let y = infoTop;
  drawInfoRow(doc, y, "Patient Name", input.patientName, "Order No", input.orderNumber);
  y += 14;
  drawInfoRow(doc, y, "Patient ID", input.patientCode, "Sample Collection",
    input.collectedAt ? dayjs(input.collectedAt).format("DD MMM YYYY, hh:mm A") : "—");
  y += 14;
  drawInfoRow(doc, y, "Age / Gender",
    `${input.patientAge ?? "—"} / ${input.patientGender ?? "—"}`,
    "Receiving Date",
    input.receivedAt ? dayjs(input.receivedAt).format("DD MMM YYYY, hh:mm A") :
      input.collectedAt ? dayjs(input.collectedAt).format("DD MMM YYYY, hh:mm A") : "—");
  y += 14;
  drawInfoRow(doc, y, "Referred By", input.referredBy ?? "—", "Report Date",
    input.approvedAt ? dayjs(input.approvedAt).format("DD MMM YYYY, hh:mm A") : "—");
  y += 14;
  drawInfoRow(doc, y, "Sample Type", input.sampleType ?? "—", "Report Status",
    input.approvedAt ? "Final" : "Pending");
  doc.y = y + 22;

  // Report title (test name)
  doc
    .font("Helvetica-Bold")
    .fillColor(C.primary)
    .fontSize(13)
    .text(input.testName.toUpperCase(), { align: "center" });
  if (input.categoryName) {
    doc.font("Helvetica").fillColor(C.muted).fontSize(9)
      .text(input.categoryName, { align: "center" });
  }
  doc.moveDown(0.6);

  // Results table
  if (input.resultData && Object.keys(input.resultData).length) {
    drawResultsTable(doc, input.resultData);
  }

  // Conclusion
  if (input.conclusion) {
    doc.moveDown(0.6);
    doc.font("Helvetica-Bold").fillColor(C.primary).fontSize(10)
      .text("Interpretation / Conclusion:");
    doc.font("Helvetica").fillColor(C.text).fontSize(9.5)
      .text(input.conclusion, { width: PAGE.width });
    doc.moveDown(0.4);
  }

  // Attached images (up to 4 in a 2x2 grid). Skip silently if files are
  // missing from disk — we don't want a stale URL to crash the PDF.
  if (input.attachmentUrls && input.attachmentUrls.length > 0) {
    const imgs = input.attachmentUrls.slice(0, 4)
      .map((url) => path.resolve(env.storageDir, "." + url.replace(/^\/uploads/, "uploads")))
      .filter((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
    if (imgs.length > 0) {
      doc.moveDown(0.4);
      doc.font("Helvetica-Bold").fillColor(C.primary).fontSize(10).text("Attached images:");
      doc.moveDown(0.2);
      const cellW = (PAGE.width - 8) / 2;
      const cellH = 150;
      const startY = doc.y;
      imgs.forEach((p, i) => {
        const col = i % 2;
        const row = Math.floor(i / 2);
        const x = PAGE.left + col * (cellW + 8);
        const y = startY + row * (cellH + 8);
        try {
          doc.image(p, x, y, { fit: [cellW, cellH], align: "center", valign: "center" });
          doc.rect(x, y, cellW, cellH).strokeColor(C.border).lineWidth(0.5).stroke();
        } catch {
          // Unsupported image format — skip this tile.
        }
      });
      const rows = Math.ceil(imgs.length / 2);
      doc.y = startY + rows * (cellH + 8);
    }
  }

  // End of report marker
  doc.moveDown(0.6);
  doc.font("Helvetica-Oblique").fillColor(C.muted).fontSize(9)
    .text("*** End Of Report ***", { align: "center" });

  // Signature + QR
  doc.moveDown(2);
  const sigY = Math.max(doc.y, PAGE.bottom - 130);

  // QR (verify) on left
  const verifyUrl = `${env.publicBaseUrl}/verify/${input.qrToken}`;
  const qr = await qrBuffer(verifyUrl);
  doc.image(qr, PAGE.left, sigY - 4, { width: 70, height: 70 });
  doc.font("Helvetica").fillColor(C.muted).fontSize(7)
    .text("Scan to verify authenticity", PAGE.left, sigY + 70, { width: 90, align: "center" });

  // Technician info center
  if (input.technicianName) {
    const tx = PAGE.left + 180;
    doc.font("Helvetica").fillColor(C.muted).fontSize(8)
      .text("Verified By:", tx, sigY + 20);
    doc.font("Helvetica-Bold").fillColor(C.text).fontSize(10)
      .text(input.technicianName, tx, sigY + 32);
    doc.font("Helvetica").fillColor(C.muted).fontSize(8)
      .text("Lab Technician", tx, sigY + 46);
  }

  // Doctor signature on right
  if (input.doctorName) {
    const dx = PAGE.right - 180;
    doc.strokeColor(C.borderDark).lineWidth(0.5)
      .moveTo(dx, sigY + 24).lineTo(dx + 160, sigY + 24).stroke();
    doc.font("Helvetica-Bold").fillColor(C.text).fontSize(10)
      .text(input.doctorName, dx, sigY + 30, { width: 160 });
    if (input.doctorQualifications) {
      doc.font("Helvetica").fillColor(C.muted).fontSize(8)
        .text(input.doctorQualifications, dx, sigY + 44, { width: 160 });
    }
    if (input.doctorBmdc) {
      doc.font("Helvetica").fillColor(C.muted).fontSize(8)
        .text(`BMDC: ${input.doctorBmdc}`, dx, sigY + 56, { width: 160 });
    }
    doc.font("Helvetica-Oblique").fillColor(C.muted).fontSize(8)
      .text("Consultant Pathologist", dx, sigY + 68, { width: 160 });
  }

  drawFooter(doc, `Printed At: ${dayjs().format("DD-MM-YYYY hh:mm A")}`);

  doc.end();
};

// ─── PRESCRIPTION ────────────────────────────────────────────────
export interface PrescriptionPdfInput {
  tenantName: string;
  tenantAddress?: string | null;
  tenantPhone?: string | null;
  tenantEmail?: string | null;
  branchName?: string | null;

  patientName: string;
  patientCode: string;
  patientAge?: string;
  patientGender?: string | null;
  patientPhone?: string;

  doctorName: string;
  doctorBmdc?: string | null;
  doctorQualifications?: string | null;
  doctorSpecialization?: string | null;

  visitDate?: Date | null;
  chiefComplaint?: string | null;
  examination?: string | null;
  vitals?: Record<string, string | number> | null;
  diagnoses: { code: string; term: string }[];
  advice?: string | null;
  notes?: string | null;
  followUpDate?: Date | null;
  items: {
    medicineName: string;
    dosage?: string | null;
    frequency?: string | null;
    durationDays?: number | null;
    instructions?: string | null;
  }[];
}

export const streamPrescriptionPdf = async (input: PrescriptionPdfInput, out: Writable) => {
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  doc.pipe(out);

  // Header
  await drawClinicHeader(doc, {
    name: input.tenantName,
    address: input.tenantAddress,
    phone: input.tenantPhone,
    email: input.tenantEmail,
    branch: input.branchName,
  });

  // Doctor strip (left-aligned, italic)
  doc.moveDown(0.4);
  const docY = doc.y;
  doc.font("Helvetica-Bold").fillColor(C.primary).fontSize(13).text(`Dr. ${input.doctorName}`, PAGE.left, docY);
  const subBits = [input.doctorQualifications, input.doctorSpecialization].filter(Boolean).join(" · ");
  if (subBits) {
    doc.font("Helvetica").fillColor(C.muted).fontSize(9).text(subBits, PAGE.left, doc.y, { width: PAGE.width });
  }
  if (input.doctorBmdc) {
    doc.font("Helvetica").fillColor(C.muted).fontSize(8).text(`BMDC: ${input.doctorBmdc}`, PAGE.left, doc.y);
  }
  doc.y = doc.y + 4;
  drawSectionBar(doc, "PRESCRIPTION");

  // Patient + visit info two-column
  doc.fillColor(C.text).font("Helvetica").fontSize(9);
  let y = doc.y + 4;
  drawInfoRow(
    doc, y,
    "Patient", input.patientName,
    "Visit Date", input.visitDate ? dayjs(input.visitDate).format("DD MMM YYYY, hh:mm A") : "—"
  );
  y += 14;
  drawInfoRow(
    doc, y,
    "Patient ID", input.patientCode,
    "Age / Gender", `${input.patientAge ?? "—"} / ${input.patientGender ?? "—"}`
  );
  y += 14;
  drawInfoRow(doc, y, "Contact", input.patientPhone ?? "—", "", "");
  doc.y = y + 20;

  // Vitals (if any)
  if (input.vitals && Object.keys(input.vitals).length) {
    doc.font("Helvetica-Bold").fillColor(C.primary).fontSize(10).text("Vitals", PAGE.left);
    doc.font("Helvetica").fillColor(C.text).fontSize(9.5);
    const bits = Object.entries(input.vitals)
      .filter(([, v]) => v !== null && v !== "")
      .map(([k, v]) => `${k}: ${v}`);
    doc.text(bits.join("   ·   "), PAGE.left, doc.y + 2, { width: PAGE.width });
    doc.moveDown(0.4);
  }

  // Complaints + examination
  if (input.chiefComplaint) {
    doc.font("Helvetica-Bold").fillColor(C.primary).fontSize(10).text("Chief Complaint");
    doc.font("Helvetica").fillColor(C.text).fontSize(9.5).text(input.chiefComplaint, { width: PAGE.width });
    doc.moveDown(0.3);
  }
  if (input.examination) {
    doc.font("Helvetica-Bold").fillColor(C.primary).fontSize(10).text("Examination");
    doc.font("Helvetica").fillColor(C.text).fontSize(9.5).text(input.examination, { width: PAGE.width });
    doc.moveDown(0.3);
  }

  // Diagnoses
  if (input.diagnoses.length) {
    doc.font("Helvetica-Bold").fillColor(C.primary).fontSize(10).text("Diagnosis");
    doc.font("Helvetica").fillColor(C.text).fontSize(9.5);
    input.diagnoses.forEach((d) => {
      doc.text(`•  ${d.code} — ${d.term}`, PAGE.left + 8, doc.y, { width: PAGE.width - 8 });
    });
    doc.moveDown(0.4);
  }

  // Rx items table — the doctor's "Rx" symbol marks the start
  doc.font("Helvetica-Bold").fillColor(C.primary).fontSize(22).text("Rx", PAGE.left, doc.y);
  doc.y = doc.y - 18;
  drawRxTable(doc, input.items);

  // Advice
  if (input.advice) {
    doc.moveDown(0.6);
    doc.font("Helvetica-Bold").fillColor(C.primary).fontSize(10).text("Advice");
    doc.font("Helvetica").fillColor(C.text).fontSize(9.5).text(input.advice, { width: PAGE.width });
  }

  // Follow-up
  if (input.followUpDate) {
    doc.moveDown(0.4);
    doc.font("Helvetica-Bold").fillColor(C.text).fontSize(10).text(
      `Follow-up: ${dayjs(input.followUpDate).format("DD MMM YYYY")}`
    );
  }

  if (input.notes) {
    doc.moveDown(0.3);
    doc.font("Helvetica-Oblique").fillColor(C.muted).fontSize(9).text(input.notes, { width: PAGE.width });
  }

  // Signature
  doc.moveDown(2.5);
  const sigY = Math.max(doc.y, PAGE.bottom - 90);
  const dx = PAGE.right - 200;
  doc.strokeColor(C.borderDark).lineWidth(0.5).moveTo(dx, sigY).lineTo(dx + 180, sigY).stroke();
  doc.font("Helvetica-Bold").fillColor(C.text).fontSize(10).text(`Dr. ${input.doctorName}`, dx, sigY + 4, { width: 180 });
  if (input.doctorBmdc) {
    doc.font("Helvetica").fillColor(C.muted).fontSize(8).text(`BMDC: ${input.doctorBmdc}`, dx, sigY + 18, { width: 180 });
  }

  drawFooter(doc, `Printed: ${dayjs().format("DD-MM-YYYY hh:mm A")}`);

  doc.end();
};

function drawRxTable(
  doc: PDFKit.PDFDocument,
  items: PrescriptionPdfInput["items"]
) {
  const cols = {
    sl: PAGE.left + 30,
    name: PAGE.left + 60,
    dose: PAGE.left + 230,
    freq: PAGE.left + 320,
    dur: PAGE.left + 400,
    note: PAGE.left + 450,
  };
  const widths = { sl: 24, name: 165, dose: 85, freq: 75, dur: 45, note: 95 };
  const rowH = 22;

  let y = doc.y;
  doc.rect(PAGE.left + 30, y, PAGE.width - 30, rowH).fillAndStroke(C.primary, C.primary);
  doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(9);
  doc.text("#", cols.sl, y + 7, { width: widths.sl, align: "center" });
  doc.text("MEDICINE", cols.name, y + 7, { width: widths.name });
  doc.text("DOSE", cols.dose, y + 7, { width: widths.dose });
  doc.text("FREQUENCY", cols.freq, y + 7, { width: widths.freq });
  doc.text("DAYS", cols.dur, y + 7, { width: widths.dur, align: "center" });
  doc.text("NOTE", cols.note, y + 7, { width: widths.note });
  y += rowH;

  items.forEach((it, idx) => {
    if (idx % 2 === 0) {
      doc.rect(PAGE.left + 30, y, PAGE.width - 30, rowH).fill(C.zebra);
    }
    doc.strokeColor(C.border).lineWidth(0.4).rect(PAGE.left + 30, y, PAGE.width - 30, rowH).stroke();
    doc.fillColor(C.text).font("Helvetica").fontSize(9.5);
    doc.text(String(idx + 1), cols.sl, y + 7, { width: widths.sl, align: "center" });
    doc.font("Helvetica-Bold").text(it.medicineName, cols.name, y + 7, { width: widths.name });
    doc.font("Helvetica").text(it.dosage ?? "—", cols.dose, y + 7, { width: widths.dose });
    doc.text(it.frequency ?? "—", cols.freq, y + 7, { width: widths.freq });
    doc.text(it.durationDays != null ? String(it.durationDays) : "—", cols.dur, y + 7, { width: widths.dur, align: "center" });
    doc.fillColor(C.muted).fontSize(8.5).text(it.instructions ?? "", cols.note, y + 7, { width: widths.note });
    y += rowH;
  });
  doc.y = y + 4;
}

// ─── INVOICE ─────────────────────────────────────────────────────
export interface InvoiceLine {
  particulars: string;
  rate: number;
  qty?: number;
  discount?: number;
  net?: number;
}

export interface InvoicePdfInput {
  tenantName: string;
  tenantAddress?: string | null;
  tenantPhone?: string | null;
  tenantEmail?: string | null;
  branchName?: string | null;

  invoiceNumber: string;
  issuedAt: Date;
  copyLabel?: string; // "CUSTOMER COPY" / "OFFICE COPY"

  patientName: string;
  patientCode: string;
  patientAge?: string;
  patientGender?: string | null;
  patientPhone?: string;
  patientAddress?: string | null;
  referredBy?: string | null;
  payerName?: string | null;

  lines: InvoiceLine[];

  subtotal: number;
  discountTotal?: number;
  vatAmount?: number;
  totalAmount: number;
  paidAmount: number;
  dueAmount: number;

  narration?: string | null;
  preparedBy?: string | null;
  paymentMethodSummary?: string | null;
}

export const streamInvoicePdf = async (input: InvoicePdfInput, out: Writable) => {
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  doc.pipe(out);

  // Header
  await drawClinicHeader(doc, {
    name: input.tenantName,
    address: input.tenantAddress,
    phone: input.tenantPhone,
    email: input.tenantEmail,
    branch: input.branchName,
  });

  // Title bar + copy label
  doc.moveDown(0.4);
  const titleY = doc.y;
  drawSectionBar(doc, "CASH BILL");
  doc.font("Helvetica-Bold").fillColor(C.muted).fontSize(9)
    .text(input.copyLabel ?? "CUSTOMER COPY", PAGE.right - 120, titleY + 5, { width: 110, align: "right" });

  // Bill / patient info — two columns
  doc.moveDown(0.4);
  doc.fillColor(C.text).font("Helvetica").fontSize(9);
  let y = doc.y;
  drawInfoRow(doc, y, "Bill No", input.invoiceNumber, "Bill Date",
    dayjs(input.issuedAt).format("DD/MM/YYYY hh:mm A"));
  y += 14;
  drawInfoRow(doc, y, "UHID", input.patientCode, "Payer", input.payerName ?? "Cash");
  y += 14;
  drawInfoRow(doc, y, "Patient Name", input.patientName, "Presc. Doctor", input.referredBy ?? "—");
  y += 14;
  drawInfoRow(doc, y, "Gender / Age",
    `${input.patientGender ?? "—"} / ${input.patientAge ?? "—"}`,
    "Lab/RIS No", input.invoiceNumber.replace(/[^\d]/g, "").slice(-8) || "—");
  y += 14;
  drawInfoRow(doc, y, "Contact No", input.patientPhone ?? "—", "Entrysite", input.branchName ?? "—");
  y += 14;
  if (input.patientAddress) {
    drawInfoRow(doc, y, "Address", input.patientAddress, "", "");
    y += 14;
  }
  doc.y = y + 4;

  // QR linking to /track/{invoiceNumber} for live status (centered, under info)
  const trackUrl = `${env.publicBaseUrl}/track/${encodeURIComponent(input.invoiceNumber)}`;
  const qrInv = await qrBuffer(trackUrl);
  const qrSize = 64;
  doc.image(qrInv, (PAGE.left + PAGE.right) / 2 - qrSize / 2, doc.y, { width: qrSize, height: qrSize });
  doc.font("Helvetica").fillColor(C.muted).fontSize(7.5)
    .text("Scan to track test progress", PAGE.left, doc.y + qrSize + 2, {
      width: PAGE.width, align: "center",
    });
  doc.y += qrSize + 14;

  // Items table
  drawInvoiceTable(doc, input.lines);

  // Totals box (right aligned, last 240px)
  const totalsX = PAGE.right - 240;
  let ty = doc.y + 6;
  const totalRow = (label: string, val: number, opts?: { bold?: boolean; color?: string }) => {
    doc.font(opts?.bold ? "Helvetica-Bold" : "Helvetica").fillColor(opts?.color ?? C.text).fontSize(9.5);
    doc.text(label, totalsX, ty, { width: 140, align: "right" });
    doc.text(money(val), totalsX + 145, ty, { width: 90, align: "right" });
    ty += 14;
  };
  totalRow("Gross Amount", input.subtotal);
  if (input.discountTotal && input.discountTotal > 0) totalRow("Discount", -input.discountTotal);
  if (input.vatAmount && input.vatAmount > 0) totalRow("VAT", input.vatAmount);
  totalRow("Net Amount", input.totalAmount, { bold: true });
  totalRow("Amount Received", input.paidAmount, { color: C.green });
  totalRow("Balance Due", input.dueAmount, {
    bold: true,
    color: input.dueAmount > 0 ? C.red : C.green,
  });
  doc.y = ty + 6;

  // Narration
  if (input.narration) {
    doc.moveDown(0.6);
    doc.font("Helvetica-Bold").fillColor(C.text).fontSize(9).text("Narration: ", { continued: true });
    doc.font("Helvetica").fillColor(C.muted).text(input.narration);
  }
  if (input.paymentMethodSummary) {
    doc.font("Helvetica").fillColor(C.muted).fontSize(9).text(`By: ${input.paymentMethodSummary}`);
  }

  // Authorised signatory (right)
  doc.moveDown(2.5);
  const sigY = Math.max(doc.y, PAGE.bottom - 90);
  doc.strokeColor(C.borderDark).lineWidth(0.5)
    .moveTo(PAGE.right - 170, sigY).lineTo(PAGE.right, sigY).stroke();
  doc.font("Helvetica-Bold").fillColor(C.text).fontSize(9)
    .text("Authorised Signatory", PAGE.right - 170, sigY + 4, { width: 170, align: "center" });
  if (input.preparedBy) {
    doc.font("Helvetica").fillColor(C.muted).fontSize(8)
      .text(`Prepared By: ${input.preparedBy}`, PAGE.left, sigY + 4);
  }

  // Footer note
  doc.fontSize(7.5).fillColor(C.muted).font("Helvetica-Oblique");
  doc.text(
    "N.B.: Please check all the information printed here is correct. Online report viewable at the patient portal using your UHID and phone number.",
    PAGE.left, PAGE.bottom - 30, { width: PAGE.width, align: "center" }
  );
  drawFooter(doc, `Printed: ${dayjs().format("DD-MM-YYYY hh:mm A")}`);

  doc.end();
};

// ─── Shared drawing helpers ──────────────────────────────────────
async function drawClinicHeader(
  doc: PDFKit.PDFDocument,
  c: { name: string; address?: string | null; phone?: string | null; email?: string | null; branch?: string | null }
) {
  // Top border
  doc.rect(PAGE.left, PAGE.top, PAGE.width, 56).fillAndStroke("#FFFFFF", C.borderDark);
  // Logo placeholder (initial)
  const initial = (c.name?.[0] ?? "D").toUpperCase();
  doc.rect(PAGE.left + 6, PAGE.top + 6, 44, 44).fillAndStroke(C.primary, C.primary);
  doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(26)
    .text(initial, PAGE.left + 6, PAGE.top + 14, { width: 44, align: "center" });

  // Clinic name
  doc.fillColor(C.primary).font("Helvetica-Bold").fontSize(16)
    .text(c.name, PAGE.left + 60, PAGE.top + 6, { width: PAGE.width - 70 });
  doc.font("Helvetica").fillColor(C.text).fontSize(8.5);
  const contactBits = [
    c.branch && `Branch: ${c.branch}`,
    c.address,
    c.phone && `Hotline: ${c.phone}`,
    c.email,
  ].filter(Boolean).join("  ·  ");
  doc.text(contactBits, PAGE.left + 60, PAGE.top + 28, { width: PAGE.width - 70 });

  doc.y = PAGE.top + 56;
}

function drawSectionBar(doc: PDFKit.PDFDocument, title: string) {
  const y = doc.y;
  doc.rect(PAGE.left, y, PAGE.width, 18).fillAndStroke("#EEF3F7", C.borderDark);
  doc.fillColor(C.primary).font("Helvetica-Bold").fontSize(10)
    .text(title, PAGE.left, y + 4, { width: PAGE.width, align: "center" });
  doc.y = y + 18;
}

function drawInfoRow(
  doc: PDFKit.PDFDocument,
  y: number,
  leftLabel: string,
  leftVal: string,
  rightLabel: string,
  rightVal: string
) {
  const leftX = PAGE.left + 4;
  const midX = PAGE.left + 250;
  doc.font("Helvetica").fillColor(C.muted).fontSize(9)
    .text(leftLabel, leftX, y, { width: 80, continued: true })
    .fillColor(C.text).font("Helvetica-Bold")
    .text(`  : ${leftVal}`, { width: 165 });
  if (rightLabel) {
    doc.font("Helvetica").fillColor(C.muted).fontSize(9)
      .text(rightLabel, midX, y, { width: 80, continued: true })
      .fillColor(C.text).font("Helvetica-Bold")
      .text(`  : ${rightVal}`, { width: 200 });
  }
}

function drawResultsTable(
  doc: PDFKit.PDFDocument,
  rows: Record<string, { value?: string; unit?: string; refRange?: string; flag?: string }>
) {
  const cols = { name: PAGE.left, value: PAGE.left + 200, unit: PAGE.left + 280, ref: PAGE.left + 330, flag: PAGE.left + 470 };
  const widths = { name: 195, value: 75, unit: 45, ref: 135, flag: 45 };
  const rowH = 18;

  let y = doc.y;
  // Header
  doc.rect(PAGE.left, y, PAGE.width, rowH).fillAndStroke(C.primary, C.primary);
  doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(9.5);
  doc.text("PARAMETER", cols.name + 6, y + 5);
  doc.text("RESULT", cols.value + 4, y + 5, { width: widths.value });
  doc.text("UNIT", cols.unit + 2, y + 5, { width: widths.unit });
  doc.text("REFERENCE RANGE", cols.ref + 4, y + 5, { width: widths.ref });
  doc.text("FLAG", cols.flag, y + 5, { width: widths.flag, align: "center" });
  y += rowH;

  let i = 0;
  for (const [name, v] of Object.entries(rows)) {
    if (i % 2 === 0) {
      doc.rect(PAGE.left, y, PAGE.width, rowH).fill(C.zebra);
    }
    doc.strokeColor(C.border).lineWidth(0.4)
      .rect(PAGE.left, y, PAGE.width, rowH).stroke();
    doc.fillColor(C.text).font("Helvetica").fontSize(9.5)
      .text(name, cols.name + 6, y + 5, { width: widths.name });
    const flagColor = v.flag === "H" ? C.red : v.flag === "L" ? C.amber : C.text;
    doc.font("Helvetica-Bold").fillColor(flagColor)
      .text(v.value ?? "—", cols.value + 4, y + 5, { width: widths.value });
    doc.font("Helvetica").fillColor(C.text)
      .text(v.unit ?? "", cols.unit + 2, y + 5, { width: widths.unit });
    doc.fillColor(C.muted).fontSize(8.5)
      .text(v.refRange ?? "", cols.ref + 4, y + 5, { width: widths.ref });
    if (v.flag && v.flag !== "N") {
      const label = v.flag === "H" ? "HIGH" : v.flag === "L" ? "LOW" : v.flag;
      doc.font("Helvetica-Bold").fillColor(flagColor).fontSize(8.5)
        .text(label, cols.flag, y + 5, { width: widths.flag, align: "center" });
    }
    y += rowH;
    i++;
  }
  doc.y = y + 4;
}

function drawInvoiceTable(doc: PDFKit.PDFDocument, lines: InvoiceLine[]) {
  const cols = {
    sl: PAGE.left,
    name: PAGE.left + 30,
    rate: PAGE.left + 240,
    disc: PAGE.left + 310,
    net: PAGE.left + 380,
    qty: PAGE.left + 450,
  };
  const widths = { sl: 28, name: 208, rate: 68, disc: 68, net: 68, qty: 65 };
  const rowH = 18;

  let y = doc.y;
  doc.rect(PAGE.left, y, PAGE.width, rowH).fillAndStroke(C.primary, C.primary);
  doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(9.5);
  doc.text("Sl.", cols.sl, y + 5, { width: widths.sl, align: "center" });
  doc.text("Particulars", cols.name + 4, y + 5, { width: widths.name });
  doc.text("Rate", cols.rate, y + 5, { width: widths.rate, align: "right" });
  doc.text("Discount", cols.disc, y + 5, { width: widths.disc, align: "right" });
  doc.text("Net Amount", cols.net, y + 5, { width: widths.net, align: "right" });
  doc.text("Qty", cols.qty, y + 5, { width: widths.qty, align: "right" });
  y += rowH;

  lines.forEach((line, idx) => {
    if (idx % 2 === 0) {
      doc.rect(PAGE.left, y, PAGE.width, rowH).fill(C.zebra);
    }
    doc.strokeColor(C.border).lineWidth(0.4).rect(PAGE.left, y, PAGE.width, rowH).stroke();
    doc.fillColor(C.text).font("Helvetica").fontSize(9.5)
      .text(String(idx + 1), cols.sl, y + 5, { width: widths.sl, align: "center" });
    doc.text(line.particulars, cols.name + 4, y + 5, { width: widths.name });
    doc.text(money(line.rate), cols.rate, y + 5, { width: widths.rate, align: "right" });
    doc.text(money(line.discount ?? 0), cols.disc, y + 5, { width: widths.disc, align: "right" });
    const net = line.net ?? (line.rate * (line.qty ?? 1) - (line.discount ?? 0));
    doc.font("Helvetica-Bold").text(money(net), cols.net, y + 5, { width: widths.net, align: "right" });
    doc.font("Helvetica").text(String(line.qty ?? 1), cols.qty, y + 5, { width: widths.qty, align: "right" });
    y += rowH;
  });
  doc.y = y;
}

function drawFooter(doc: PDFKit.PDFDocument, leftText: string) {
  doc.font("Helvetica").fillColor(C.muted).fontSize(7.5);
  doc.text(leftText, PAGE.left, PAGE.bottom + 5);
  doc.text(`Powered by ${env.appName}`, PAGE.left, PAGE.bottom + 5, {
    width: PAGE.width, align: "right",
  });
}

const money = (n: number) =>
  n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
