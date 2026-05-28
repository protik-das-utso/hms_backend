import QRCode from "qrcode";

export const qrDataUrl = (text: string) =>
  QRCode.toDataURL(text, { margin: 1, width: 180, errorCorrectionLevel: "M" });

export const qrBuffer = (text: string) =>
  QRCode.toBuffer(text, { margin: 1, width: 180, errorCorrectionLevel: "M" });
