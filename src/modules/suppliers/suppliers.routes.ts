import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRoles, requireFeature } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { UserRole } from "@prisma/client";
import * as ctrl from "./suppliers.controller";

export const suppliersRouter = Router();

const ADMIN = [UserRole.SUPER_ADMIN, UserRole.BRANCH_ADMIN, UserRole.PHARMACIST];

const createSchema = z.object({
  name: z.string().min(1).max(150),
  contactPerson: z.string().max(150).optional(),
  phone: z.string().max(20).optional(),
  email: z.string().email().max(200).optional().or(z.literal("")),
  address: z.string().optional(),
  vatRegNo: z.string().max(50).optional(),
  notes: z.string().optional(),
  isActive: z.boolean().optional(),
});

const updateSchema = createSchema.partial();

suppliersRouter.use(authenticate, requireFeature("pharmacy"));
suppliersRouter.get("/", asyncHandler(ctrl.list));
suppliersRouter.get("/:id", asyncHandler(ctrl.getOne));
suppliersRouter.post("/", requireRoles(...ADMIN), validate(createSchema), asyncHandler(ctrl.create));
suppliersRouter.put("/:id", requireRoles(...ADMIN), validate(updateSchema), asyncHandler(ctrl.update));
suppliersRouter.delete("/:id", requireRoles(...ADMIN), asyncHandler(ctrl.remove));
