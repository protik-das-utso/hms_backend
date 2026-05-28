import { Router } from "express";
import { z } from "zod";
import { authenticate, requirePermission } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import * as ctrl from "./patients.controller";

export const patientsRouter = Router();

const createSchema = z.object({
  name: z.string().min(2).max(150),
  phone: z.string().min(6).max(20),
  email: z.string().email().optional().or(z.literal("")),
  dob: z.string().optional(),
  gender: z.enum(["MALE", "FEMALE", "OTHER"]).optional(),
  address: z.string().optional(),
  nid: z.string().optional(),
  bloodGroup: z.string().optional(),
  allergies: z.string().optional(),
  emergencyContact: z.string().optional(),
  branchId: z.string().uuid().optional(),
  notes: z.string().optional(),
  photoUrl: z.string().max(500).optional(),
  corporateClientId: z.string().uuid().optional().or(z.literal("")),
  corporateEmpId: z.string().max(60).optional().or(z.literal("")),
});

const updateSchema = createSchema.partial();

patientsRouter.use(authenticate);

// Permission-gated: super admin can grant/revoke per role in /settings/permissions.
patientsRouter.get("/",    requirePermission("patients:read"),   asyncHandler(ctrl.list));
patientsRouter.get("/:id", requirePermission("patients:read"),   asyncHandler(ctrl.getOne));
patientsRouter.post("/",   requirePermission("patients:create"), validate(createSchema), asyncHandler(ctrl.create));
patientsRouter.put("/:id", requirePermission("patients:update"), validate(updateSchema), asyncHandler(ctrl.update));
patientsRouter.delete("/:id", requirePermission("patients:delete"), asyncHandler(ctrl.softDelete));

patientsRouter.get("/:id/orders", asyncHandler(ctrl.listOrders));
patientsRouter.get("/:id/invoices", asyncHandler(ctrl.listInvoices));
