import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRoles, requireFeature } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { UserRole } from "@prisma/client";
import * as terms from "./employment-terms.controller";
import * as payroll from "./payroll.controller";
import * as loans from "./loans.controller";
import * as leaves from "./leaves.controller";
import * as attendance from "./attendance.controller";
import * as roster from "./roster.controller";

export const hrRouter = Router();

const ADMIN = [UserRole.SUPER_ADMIN, UserRole.BRANCH_ADMIN, UserRole.HR_MANAGER];
const STAFF = [
  UserRole.SUPER_ADMIN, UserRole.BRANCH_ADMIN, UserRole.HR_MANAGER,
  UserRole.DOCTOR, UserRole.NURSE, UserRole.RECEPTIONIST, UserRole.LAB_TECHNICIAN,
  UserRole.PHARMACIST, UserRole.ACCOUNTANT,
];

// ── Employment terms ─────────────────────────────────────

const termsSchema = z.object({
  employmentType: z.enum(["FULL_TIME", "PART_TIME", "CONTRACT", "INTERN", "CONSULTANT"]).optional(),
  designation: z.string().max(120).optional(),
  joinedAt: z.string().optional(),
  basicSalary: z.number().nonnegative().optional(),
  houseAllowance: z.number().nonnegative().optional(),
  medicalAllowance: z.number().nonnegative().optional(),
  transportAllowance: z.number().nonnegative().optional(),
  otherAllowances: z.number().nonnegative().optional(),
  taxDeductionPercent: z.number().min(0).max(100).optional(),
  pfEmployeePercent: z.number().min(0).max(100).optional(),
  pfEmployerPercent: z.number().min(0).max(100).optional(),
  notes: z.string().optional(),
});

// ── Payroll ───────────────────────────────────────────────

const runSchema = z.object({
  branchId: z.string().uuid().optional(),
  periodYear: z.number().int().min(2020).max(2100),
  periodMonth: z.number().int().min(1).max(12),
  notes: z.string().optional(),
});

const slipPaySchema = z.object({
  paidVia: z.enum(["CASH", "BKASH", "NAGAD", "ROCKET", "CARD", "BANK_TRANSFER"]).optional(),
  paidReferenceNo: z.string().max(80).optional(),
});

// ── Loans ─────────────────────────────────────────────────

const loanSchema = z.object({
  userId: z.string().uuid(),
  principal: z.number().positive(),
  monthlyDeduction: z.number().positive(),
  takenOn: z.string().optional(),
  reason: z.string().optional(),
  writeExpense: z.boolean().optional(),
});

// ── Leaves ────────────────────────────────────────────────

const leaveTypeSchema = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(80),
  daysPerYear: z.number().int().nonnegative().optional(),
  paid: z.boolean().optional(),
  carryForward: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

const leaveRequestSchema = z.object({
  leaveTypeId: z.string().uuid(),
  fromDate: z.string().min(1),
  toDate: z.string().min(1),
  reason: z.string().optional(),
});

const reviewSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  reviewNote: z.string().optional(),
});

// ── Attendance ────────────────────────────────────────────

const attendanceUpsertSchema = z.object({
  userId: z.string().uuid(),
  date: z.string().min(1),
  status: z.enum(["PRESENT", "ABSENT", "LEAVE", "HOLIDAY", "HALF_DAY", "WEEKEND"]),
  branchId: z.string().uuid().optional(),
  checkIn: z.string().optional(),
  checkOut: z.string().optional(),
  notes: z.string().optional(),
});

// ── Roster ────────────────────────────────────────────────

const shiftSchema = z.object({
  branchId: z.string().uuid().optional(),
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(80),
  startTime: z.string().min(1).max(8),
  endTime: z.string().min(1).max(8),
  colorHex: z.string().max(7).optional(),
});

const assignSchema = z.object({
  userId: z.string().uuid(),
  shiftId: z.string().uuid(),
  date: z.string().min(1),
  branchId: z.string().uuid().optional(),
  notes: z.string().optional(),
});

hrRouter.use(authenticate, requireFeature("hr"));

// Employment terms (admin only)
hrRouter.get("/terms", requireRoles(...ADMIN), asyncHandler(terms.listTerms));
hrRouter.get("/terms/:userId", requireRoles(...ADMIN), asyncHandler(terms.getTerms));
hrRouter.put("/terms/:userId", requireRoles(...ADMIN), validate(termsSchema), asyncHandler(terms.upsertTerms));

// Payroll
hrRouter.get("/payroll", requireRoles(...ADMIN), asyncHandler(payroll.listRuns));
hrRouter.get("/payroll/my-slips", requireRoles(...STAFF), asyncHandler(payroll.myPayslips));
hrRouter.get("/payroll/:id", requireRoles(...ADMIN), asyncHandler(payroll.getRun));
hrRouter.post("/payroll", requireRoles(...ADMIN), validate(runSchema), asyncHandler(payroll.createRun));
hrRouter.post("/payroll/:id/finalize", requireRoles(...ADMIN), asyncHandler(payroll.finalizeRun));
hrRouter.post("/payroll/:id/cancel", requireRoles(...ADMIN), asyncHandler(payroll.cancelRun));
hrRouter.post("/payroll/slips/:id/pay", requireRoles(...ADMIN), validate(slipPaySchema), asyncHandler(payroll.markSlipPaid));

// Loans
hrRouter.get("/loans", requireRoles(...ADMIN), asyncHandler(loans.list));
hrRouter.post("/loans", requireRoles(...ADMIN), validate(loanSchema), asyncHandler(loans.create));
hrRouter.post("/loans/:id/settle", requireRoles(...ADMIN), asyncHandler(loans.settle));
hrRouter.post("/loans/:id/cancel", requireRoles(...ADMIN), asyncHandler(loans.cancel));

// Leaves
hrRouter.get("/leave-types", requireRoles(...STAFF), asyncHandler(leaves.listTypes));
hrRouter.post("/leave-types", requireRoles(...ADMIN), validate(leaveTypeSchema), asyncHandler(leaves.createType));
hrRouter.put("/leave-types/:id", requireRoles(...ADMIN), validate(leaveTypeSchema.partial()), asyncHandler(leaves.updateType));
hrRouter.get("/leaves/my-balance", requireRoles(...STAFF), asyncHandler(leaves.getMyBalance));
hrRouter.post("/leaves/seed-year", requireRoles(...ADMIN), asyncHandler(leaves.seedYearBalances));
hrRouter.get("/leaves", requireRoles(...STAFF), asyncHandler(leaves.listRequests));
hrRouter.post("/leaves", requireRoles(...STAFF), validate(leaveRequestSchema), asyncHandler(leaves.createRequest));
hrRouter.post("/leaves/:id/review", requireRoles(...ADMIN), validate(reviewSchema), asyncHandler(leaves.reviewRequest));
hrRouter.post("/leaves/:id/cancel", requireRoles(...STAFF), asyncHandler(leaves.cancelRequest));

// Attendance
hrRouter.get("/attendance", requireRoles(...STAFF), asyncHandler(attendance.list));
hrRouter.post("/attendance", requireRoles(...ADMIN), validate(attendanceUpsertSchema), asyncHandler(attendance.upsert));
hrRouter.post("/attendance/punch", requireRoles(...STAFF), asyncHandler(attendance.punch));
hrRouter.post("/attendance/bulk", requireRoles(...ADMIN), asyncHandler(attendance.bulkUpsert));

// Roster
hrRouter.get("/shifts", requireRoles(...STAFF), asyncHandler(roster.listShifts));
hrRouter.post("/shifts", requireRoles(...ADMIN), validate(shiftSchema), asyncHandler(roster.createShift));
hrRouter.put("/shifts/:id", requireRoles(...ADMIN), validate(shiftSchema.partial()), asyncHandler(roster.updateShift));
hrRouter.delete("/shifts/:id", requireRoles(...ADMIN), asyncHandler(roster.deleteShift));
hrRouter.get("/roster", requireRoles(...STAFF), asyncHandler(roster.listRoster));
hrRouter.post("/roster", requireRoles(...ADMIN), validate(assignSchema), asyncHandler(roster.assignShift));
hrRouter.delete("/roster/:id", requireRoles(...ADMIN), asyncHandler(roster.unassignShift));
