import { Router } from "express";
import { z } from "zod";
import { validate } from "../../middleware/validate";
import { authenticate } from "../../middleware/auth";
import { loginLimiter, otpRequestLimiter, otpVerifyLimiter } from "../../middleware/rateLimit";
import { asyncHandler } from "../../utils/asyncHandler";
import * as ctrl from "./auth.controller";

export const authRouter = Router();

const loginSchema = z.object({
  phone: z.string().min(6).max(20),
  password: z.string().min(6).max(100),
});

const refreshSchema = z.object({ refreshToken: z.string().min(10) });

const forgotSchema = z.object({ phone: z.string().min(6).max(20) });

const resetSchema = z.object({
  phone: z.string().min(6).max(20),
  otp: z.string().length(6),
  newPassword: z.string().min(6).max(100),
});

const patientOtpRequestSchema = z.object({
  phone: z.string().min(6).max(20),
  tenantSlug: z.string().min(2).max(80),
});

const patientOtpVerifySchema = z.object({
  phone: z.string().min(6).max(20),
  tenantSlug: z.string().min(2).max(80),
  otp: z.string().length(6),
});

authRouter.post("/login", loginLimiter, validate(loginSchema), asyncHandler(ctrl.login));
// Owner-only login — used by the /owner page on the frontend. Rejects any
// caller who isn't a SUPER_ADMIN on the platform tenant.
authRouter.post("/platform-login", loginLimiter, validate(loginSchema), asyncHandler(ctrl.platformLogin));
authRouter.post("/refresh", validate(refreshSchema), asyncHandler(ctrl.refresh));
authRouter.post("/logout", authenticate, asyncHandler(ctrl.logout));
authRouter.get("/me", authenticate, asyncHandler(ctrl.me));

authRouter.post("/forgot-password", otpRequestLimiter, validate(forgotSchema), asyncHandler(ctrl.forgotPassword));
authRouter.post("/reset-password", otpVerifyLimiter, validate(resetSchema), asyncHandler(ctrl.resetPassword));

authRouter.post(
  "/patient/request-otp",
  otpRequestLimiter,
  validate(patientOtpRequestSchema),
  asyncHandler(ctrl.patientRequestOtp)
);
authRouter.post(
  "/patient/verify-otp",
  otpVerifyLimiter,
  validate(patientOtpVerifySchema),
  asyncHandler(ctrl.patientVerifyOtp)
);

// ─── Self-service profile + password ──────────────────────────
const updateMeSchema = z.object({
  name: z.string().trim().min(2).max(150).optional(),
  email: z.string().email().max(200).optional().or(z.literal("")),
  photoUrl: z.string().max(500).optional().or(z.literal("")),
});
const changePasswordSchema = z.object({
  currentPassword: z.string().min(6).max(100),
  newPassword: z.string().min(6).max(100),
});
authRouter.put("/me", authenticate, validate(updateMeSchema), asyncHandler(ctrl.updateMe));
authRouter.post(
  "/change-password",
  authenticate,
  validate(changePasswordSchema),
  asyncHandler(ctrl.changePassword)
);
