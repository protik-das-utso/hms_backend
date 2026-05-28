import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRoles } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { UserRole } from "@prisma/client";
import * as ctrl from "./health-cards.controller";

export const healthCardsRouter = Router();

const ADMIN = [UserRole.SUPER_ADMIN, UserRole.BRANCH_ADMIN];
const STAFF = [UserRole.SUPER_ADMIN, UserRole.BRANCH_ADMIN, UserRole.RECEPTIONIST, UserRole.ACCOUNTANT];

const cardSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().optional(),
  discountPercent: z.number().min(0).max(100).optional(),
  monthlyFee: z.number().nonnegative().optional(),
  validityDays: z.number().int().positive().optional(),
  isActive: z.boolean().optional(),
});

const assignSchema = z.object({
  patientId: z.string().uuid(),
  cardId: z.string().uuid(),
  cardNumber: z.string().max(40).optional(),
  issuedAt: z.string().optional(),
  notes: z.string().optional(),
});

healthCardsRouter.use(authenticate);

healthCardsRouter.get("/", requireRoles(...STAFF), asyncHandler(ctrl.listCards));
healthCardsRouter.post("/", requireRoles(...ADMIN), validate(cardSchema), asyncHandler(ctrl.createCard));
healthCardsRouter.put("/:id", requireRoles(...ADMIN), validate(cardSchema.partial()), asyncHandler(ctrl.updateCard));

healthCardsRouter.get("/patient/:patientId", requireRoles(...STAFF), asyncHandler(ctrl.getForPatient));
healthCardsRouter.post("/assign", requireRoles(...STAFF), validate(assignSchema), asyncHandler(ctrl.assignToPatient));
healthCardsRouter.post("/patient/:patientId/revoke", requireRoles(...STAFF), asyncHandler(ctrl.revokeForPatient));
