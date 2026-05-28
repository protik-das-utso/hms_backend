import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRoles } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { UserRole } from "@prisma/client";
import * as ctrl from "./notices.controller";

export const noticesRouter = Router();

const POSTERS = [UserRole.SUPER_ADMIN, UserRole.BRANCH_ADMIN, UserRole.HR_MANAGER];

const AUDIENCES = ["ALL_STAFF", "DOCTORS", "NURSES", "RECEPTIONISTS", "LAB", "PHARMACY", "ACCOUNTS", "ADMINS"] as const;

const createSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1),
  branchId: z.string().uuid().optional(),
  audience: z.enum(AUDIENCES).optional(),
  pinned: z.boolean().optional(),
  expiresAt: z.string().optional(),
});

noticesRouter.use(authenticate);

noticesRouter.get("/", asyncHandler(ctrl.list));
noticesRouter.get("/unread-count", asyncHandler(ctrl.unreadCount));
noticesRouter.post("/", requireRoles(...POSTERS), validate(createSchema), asyncHandler(ctrl.create));
noticesRouter.put("/:id", requireRoles(...POSTERS), validate(createSchema.partial()), asyncHandler(ctrl.update));
noticesRouter.delete("/:id", requireRoles(...POSTERS), asyncHandler(ctrl.remove));
noticesRouter.post("/:id/read", asyncHandler(ctrl.markRead));
noticesRouter.post("/mark-all-read", asyncHandler(ctrl.markAllRead));
