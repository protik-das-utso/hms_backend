import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRoles, requireFeature } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { UserRole } from "@prisma/client";
import * as ctrl from "./corporate-clients.controller";

export const corporateClientsRouter = Router();
export const corporateStatementsRouter = Router();

const ALL_BILLING = [
  UserRole.SUPER_ADMIN,
  UserRole.BRANCH_ADMIN,
  UserRole.ACCOUNTANT,
  UserRole.RECEPTIONIST,
];
const ADMIN_FIN = [UserRole.SUPER_ADMIN, UserRole.BRANCH_ADMIN, UserRole.ACCOUNTANT];

const clientCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  type: z.enum(["COMPANY", "INSURANCE", "GOVT_AGENCY", "NGO"]).optional(),
  contactPerson: z.string().max(150).optional().or(z.literal("")),
  phone: z.string().max(20).optional().or(z.literal("")),
  email: z.string().email().max(200).optional().or(z.literal("")),
  address: z.string().optional().or(z.literal("")),
  taxId: z.string().max(50).optional().or(z.literal("")),
  discountPercent: z.coerce.number().min(0).max(100).optional(),
  creditLimit: z.coerce.number().min(0).optional(),
  paymentTermsDays: z.coerce.number().int().min(0).max(365).optional(),
  notes: z.string().optional().or(z.literal("")),
  isActive: z.boolean().optional(),
});

const clientUpdateSchema = clientCreateSchema.partial();

const generateSchema = z.object({
  periodFrom: z.string().min(8),
  periodTo: z.string().min(8),
  notes: z.string().optional().or(z.literal("")),
});

const paymentSchema = z.object({
  amount: z.coerce.number().positive(),
  method: z.enum(["CASH", "BKASH", "NAGAD", "ROCKET", "CARD", "BANK_TRANSFER"]).optional(),
  referenceNo: z.string().max(100).optional().or(z.literal("")),
  notes: z.string().optional().or(z.literal("")),
});

// ─── /corporate-clients ──────────────────────────────────────────

corporateClientsRouter.use(authenticate, requireFeature("corporate"));
corporateClientsRouter.get("/", requireRoles(...ALL_BILLING), asyncHandler(ctrl.listClients));
corporateClientsRouter.get("/:id", requireRoles(...ALL_BILLING), asyncHandler(ctrl.getClient));
corporateClientsRouter.post("/", requireRoles(...ADMIN_FIN), validate(clientCreateSchema), asyncHandler(ctrl.createClient));
corporateClientsRouter.put("/:id", requireRoles(...ADMIN_FIN), validate(clientUpdateSchema), asyncHandler(ctrl.updateClient));
corporateClientsRouter.delete("/:id", requireRoles(...ADMIN_FIN), asyncHandler(ctrl.removeClient));

corporateClientsRouter.get("/:id/patients", requireRoles(...ALL_BILLING), asyncHandler(ctrl.listClientPatients));
corporateClientsRouter.get("/:id/statements", requireRoles(...ALL_BILLING), asyncHandler(ctrl.listClientStatements));
corporateClientsRouter.post(
  "/:id/statements/generate",
  requireRoles(...ADMIN_FIN),
  validate(generateSchema),
  asyncHandler(ctrl.generateStatement)
);

// ─── /corporate-statements ───────────────────────────────────────

corporateStatementsRouter.use(authenticate, requireFeature("corporate"));
corporateStatementsRouter.get("/", requireRoles(...ALL_BILLING), asyncHandler(ctrl.listAllStatements));
corporateStatementsRouter.get("/:id", requireRoles(...ALL_BILLING), asyncHandler(ctrl.getStatement));
corporateStatementsRouter.post(
  "/:id/payments",
  requireRoles(...ADMIN_FIN),
  validate(paymentSchema),
  asyncHandler(ctrl.recordStatementPayment)
);
corporateStatementsRouter.post("/:id/cancel", requireRoles(...ADMIN_FIN), asyncHandler(ctrl.cancelStatement));
