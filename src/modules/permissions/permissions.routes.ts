import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRoles, requirePermission } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { UserRole } from "@prisma/client";
import * as ctrl from "./permissions.controller";

export const permissionsRouter = Router();

permissionsRouter.use(authenticate);

// Any authenticated user can fetch the catalogue (needed for "mine") and
// their own effective permissions.
permissionsRouter.get("/catalogue", asyncHandler(ctrl.catalogue));
permissionsRouter.get("/mine", asyncHandler(ctrl.mine));

// Matrix + writes — SUPER_ADMIN of the tenant only.
permissionsRouter.get("/matrix", requireRoles(UserRole.SUPER_ADMIN), asyncHandler(ctrl.matrix));

const updateSchema = z.object({
  entries: z.array(z.object({
    role: z.string().min(1).max(40),
    code: z.string().min(1).max(80),
    allowed: z.boolean(),
  })).min(1).max(1000),
});

permissionsRouter.put(
  "/matrix",
  requireRoles(UserRole.SUPER_ADMIN),
  validate(updateSchema),
  asyncHandler(ctrl.update)
);

permissionsRouter.post(
  "/reset",
  requireRoles(UserRole.SUPER_ADMIN),
  asyncHandler(ctrl.reset)
);
