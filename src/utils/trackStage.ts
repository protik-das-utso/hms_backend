import { OrderStatus, ReportStatus } from "@prisma/client";

export type TrackStage =
  | "PENDING"
  | "SAMPLE_COLLECTED"
  | "IN_LAB"
  | "RESULT_DRAFTED"
  | "AWAITING_APPROVAL"
  | "REPORT_READY"
  | "DELIVERED"
  | "CANCELLED";

export const STAGE_LABELS: Record<TrackStage, string> = {
  PENDING: "Pending sample collection",
  SAMPLE_COLLECTED: "Sample collected",
  IN_LAB: "Testing in lab",
  RESULT_DRAFTED: "Result being drafted",
  AWAITING_APPROVAL: "Awaiting doctor approval",
  REPORT_READY: "Report ready",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
};

// Linear order used by the UI timeline. Doesn't include CANCELLED.
export const STAGE_FLOW: TrackStage[] = [
  "PENDING",
  "SAMPLE_COLLECTED",
  "IN_LAB",
  "AWAITING_APPROVAL",
  "REPORT_READY",
];

export const computeStage = (
  itemStatus: OrderStatus,
  reportStatus?: ReportStatus | null
): TrackStage => {
  if (itemStatus === "CANCELLED") return "CANCELLED";
  if (itemStatus === "DELIVERED") return "DELIVERED";
  if (reportStatus === "APPROVED" || reportStatus === "PUBLISHED") return "REPORT_READY";
  if (reportStatus === "PENDING_APPROVAL") return "AWAITING_APPROVAL";
  if (reportStatus === "DRAFT") return "RESULT_DRAFTED";
  if (itemStatus === "IN_LAB" || itemStatus === "PROCESSING") return "IN_LAB";
  if (itemStatus === "SAMPLE_COLLECTED") return "SAMPLE_COLLECTED";
  return "PENDING";
};
