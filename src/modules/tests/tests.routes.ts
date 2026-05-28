import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRoles } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { UserRole } from "@prisma/client";
import * as ctrl from "./tests.controller";

export const testsRouter = Router();

const ADMIN = [UserRole.SUPER_ADMIN, UserRole.BRANCH_ADMIN];

const categorySchema = z.object({
  nameEn: z.string().min(1).max(100),
  nameBn: z.string().max(100).optional(),
  icon: z.string().max(50).optional(),
  sortOrder: z.number().int().optional(),
});

const testSchema = z.object({
  categoryId: z.string().uuid(),
  code: z.string().min(2).max(30),
  nameEn: z.string().min(2).max(200),
  nameBn: z.string().max(200).optional(),
  sampleType: z.string().max(100).optional(),
  basePrice: z.number().nonnegative(),
  turnaroundHours: z.number().int().nonnegative().optional(),
  instructions: z.string().optional(),
  // resultSchema: ordered list of parameters the lab fills in per report.
  // `defaultValue` lets the admin pre-fill an example so the tech only has
  // to confirm normal cases.
  resultSchema: z
    .array(
      z.object({
        field: z.string().min(1).max(150),
        unit: z.string().max(40).optional(),
        refRange: z.string().max(200).optional(),
        defaultValue: z.string().max(80).optional(),
      })
    )
    .optional(),
});

const testUpdateSchema = testSchema.partial().extend({ isActive: z.boolean().optional() });

testsRouter.use(authenticate);

// Categories
testsRouter.get("/categories", asyncHandler(ctrl.listCategories));
testsRouter.post(
  "/categories",
  requireRoles(...ADMIN),
  validate(categorySchema),
  asyncHandler(ctrl.createCategory)
);
testsRouter.put(
  "/categories/:id",
  requireRoles(...ADMIN),
  validate(categorySchema.partial()),
  asyncHandler(ctrl.updateCategory)
);
testsRouter.delete("/categories/:id", requireRoles(...ADMIN), asyncHandler(ctrl.deleteCategory));

// Tests
testsRouter.get("/", asyncHandler(ctrl.listTests));
testsRouter.get("/:id", asyncHandler(ctrl.getTest));
testsRouter.post("/", requireRoles(...ADMIN), validate(testSchema), asyncHandler(ctrl.createTest));
testsRouter.put(
  "/:id",
  requireRoles(...ADMIN),
  validate(testUpdateSchema),
  asyncHandler(ctrl.updateTest)
);
testsRouter.delete("/:id", requireRoles(...ADMIN), asyncHandler(ctrl.deleteTest));
