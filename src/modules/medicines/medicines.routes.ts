import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRoles, requireFeature } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { UserRole } from "@prisma/client";
import * as ctrl from "./medicines.controller";

export const medicinesRouter = Router();

const ADMIN = [UserRole.SUPER_ADMIN, UserRole.BRANCH_ADMIN, UserRole.PHARMACIST];

const createSchema = z.object({
  brandName: z.string().min(1).max(200),
  genericName: z.string().max(200).optional(),
  strength: z.string().max(100).optional(),
  form: z.string().max(50).optional(),
  manufacturer: z.string().max(150).optional(),
  dgdaCode: z.string().max(50).optional(),
  barcode: z.string().max(60).optional(),
  salePrice: z.number().nonnegative(),
  unitsPerBox: z.number().int().positive().optional(),
  boxPrice: z.number().nonnegative().nullable().optional(),
  reorderLevel: z.number().int().nonnegative().optional(),
  taxRate: z.number().nonnegative().optional(),
  isActive: z.boolean().optional(),
});

const updateSchema = createSchema.partial();

medicinesRouter.use(authenticate, requireFeature("pharmacy"));
// Specific routes BEFORE the :id catch-all so /by-barcode isn't treated as an id.
medicinesRouter.get("/by-barcode", asyncHandler(ctrl.byBarcode));
medicinesRouter.get("/", asyncHandler(ctrl.list));
medicinesRouter.get("/:id", asyncHandler(ctrl.getOne));
medicinesRouter.post("/", requireRoles(...ADMIN), validate(createSchema), asyncHandler(ctrl.create));
medicinesRouter.put("/:id", requireRoles(...ADMIN), validate(updateSchema), asyncHandler(ctrl.update));
medicinesRouter.delete("/:id", requireRoles(UserRole.SUPER_ADMIN, UserRole.BRANCH_ADMIN), asyncHandler(ctrl.softDelete));
