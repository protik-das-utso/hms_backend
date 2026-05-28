import crypto from "crypto";
import dayjs from "dayjs";

const pad = (n: number, len = 4) => String(n).padStart(len, "0");

export const patientCode = (seq: number) =>
  `PAT-${dayjs().format("YYYYMMDD")}-${pad(seq, 4)}`;

export const orderNumber = (seq: number) =>
  `ORD-${dayjs().format("YYMMDD")}-${pad(seq, 5)}`;

export const invoiceNumber = (seq: number) =>
  `INV-${dayjs().format("YYMMDD")}-${pad(seq, 5)}`;

export const admissionNumber = (seq: number) =>
  `IPD-${dayjs().format("YYMMDD")}-${pad(seq, 5)}`;

export const barcode = () =>
  `SMP-${dayjs().format("YYMMDD")}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

export const qrToken = () => crypto.randomBytes(24).toString("hex");

export const numericOtp = (digits = 6) => {
  const max = 10 ** digits;
  return String(crypto.randomInt(0, max)).padStart(digits, "0");
};
