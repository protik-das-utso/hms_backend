import { Router } from "express";
import { z } from "zod";
import { validate } from "../../middleware/validate";
import { signupLimiter } from "../../middleware/rateLimit";
import { asyncHandler } from "../../utils/asyncHandler";
import * as ctrl from "./signup.controller";

export const signupRouter = Router();

const signupSchema = z.object({
  clinicName: z.string().trim().min(2).max(150),
  contactName: z.string().trim().min(2).max(150),
  phone: z.string().trim().min(6).max(20),
  email: z.string().email().max(200).optional().or(z.literal("")),
  password: z.string().min(6).max(72),
  branchName: z.string().max(150).optional().or(z.literal("")),
  planCode: z.string().max(40).optional(),
});

signupRouter.post("/", signupLimiter, validate(signupSchema), asyncHandler(ctrl.signup));
signupRouter.get("/check-slug", asyncHandler(ctrl.checkSlug));
