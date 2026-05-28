import { Request, Response } from "express";
import crypto from "crypto";
import dayjs from "dayjs";
import { prisma } from "../../config/db";
import { hashPassword, verifyPassword } from "../../utils/password";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "../../utils/jwt";
import { ApiError } from "../../utils/ApiError";
import { ok } from "../../utils/apiResponse";
import { numericOtp } from "../../utils/codes";
import { notify } from "../../utils/notify";

const hashRefresh = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

const issueTokens = async (
  user: { id: string; tenantId: string; role: string; branchId: string | null },
  req: Request,
) => {
  const tokenId = crypto.randomUUID();
  const access = signAccessToken({
    sub: user.id,
    tenantId: user.tenantId,
    role: user.role,
    branchId: user.branchId ?? undefined,
  });
  const refresh = signRefreshToken({ sub: user.id, tokenId });

  await prisma.refreshToken.create({
    data: {
      id: tokenId,
      userId: user.id,
      tokenHash: hashRefresh(refresh),
      expiresAt: dayjs().add(7, "day").toDate(),
      userAgent: req.headers["user-agent"]?.toString().slice(0, 255),
      ipAddress: req.ip?.slice(0, 45),
    },
  });

  return { accessToken: access, refreshToken: refresh };
};

// ─── Standard clinic login ──────────────────────────────────

export const login = async (req: Request, res: Response) => {
  const { phone, password } = req.body as { phone: string; password: string };

  const user = await prisma.user.findFirst({
    where: { phone, deletedAt: null },
    include: { tenant: { select: { id: true, name: true, slug: true, isActive: true, isPlatform: true } } },
  });
  if (!user || !user.isActive || !user.tenant.isActive) {
    throw ApiError.unauthorized("Invalid credentials");
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw ApiError.unauthorized("Account locked. Try again later.");
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    const attempts = user.failedAttempts + 1;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedAttempts: attempts,
        lockedUntil: attempts >= 5 ? dayjs().add(15, "minute").toDate() : null,
      },
    });
    throw ApiError.unauthorized("Invalid credentials");
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
  });

  const tokens = await issueTokens(user, req);

  ok(res, {
    ...tokens,
    user: {
      id: user.id,
      name: user.name,
      phone: user.phone,
      email: user.email,
      role: user.role,
      branchId: user.branchId,
      photoUrl: user.photoUrl,
      tenant: { id: user.tenant.id, name: user.tenant.name, slug: user.tenant.slug, isPlatform: user.tenant.isPlatform },
    },
  }, "Login successful");
};

// ─── Owner-only login ──────────────────────────────────────
//
// Identical credentials check to `login`, but rejects the request unless the
// user is a SUPER_ADMIN on the platform tenant. The error message is the
// same for every failure mode (wrong phone, wrong password, not platform
// tenant, not SUPER_ADMIN) so attackers can't enumerate who's the owner by
// spraying phone numbers.

export const platformLogin = async (req: Request, res: Response) => {
  const { phone, password } = req.body as { phone: string; password: string };
  const generic = ApiError.unauthorized("Invalid credentials or insufficient privileges");

  // Scope the lookup to the platform tenant's SUPER_ADMINs. Phone is only
  // unique per-tenant, so the same number can belong to a clinic user AND the
  // platform owner; an unscoped findFirst could return the clinic user and
  // reject a legitimate owner. Filtering here resolves that collision.
  const user = await prisma.user.findFirst({
    where: { phone, deletedAt: null, role: "SUPER_ADMIN", tenant: { isPlatform: true } },
    include: { tenant: { select: { id: true, name: true, slug: true, isActive: true, isPlatform: true } } },
  });
  if (!user || !user.isActive || !user.tenant.isActive) throw generic;
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw ApiError.unauthorized("Account locked. Try again later.");
  }

  // Pre-check privilege BEFORE password verification so the failed-attempts
  // counter doesn't get incremented for accounts that could never log in
  // here anyway. Legit owners that mistype the password still get the
  // rate-limit treatment below.
  if (!user.tenant.isPlatform || user.role !== "SUPER_ADMIN") throw generic;

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    const attempts = user.failedAttempts + 1;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedAttempts: attempts,
        lockedUntil: attempts >= 5 ? dayjs().add(15, "minute").toDate() : null,
      },
    });
    throw generic;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
  });

  const tokens = await issueTokens(user, req);

  ok(res, {
    ...tokens,
    user: {
      id: user.id,
      name: user.name,
      phone: user.phone,
      email: user.email,
      role: user.role,
      branchId: user.branchId,
      photoUrl: user.photoUrl,
      tenant: {
        id: user.tenant.id, name: user.tenant.name, slug: user.tenant.slug,
        isPlatform: user.tenant.isPlatform,
      },
    },
  }, "Welcome back, owner.");
};

// ─── Token lifecycle ──────────────────────────────────────

export const refresh = async (req: Request, res: Response) => {
  const { refreshToken } = req.body as { refreshToken: string };
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw ApiError.unauthorized("Invalid refresh token");
  }

  const stored = await prisma.refreshToken.findUnique({
    where: { id: payload.tokenId },
    include: { user: true },
  });
  if (
    !stored ||
    stored.revoked ||
    stored.expiresAt < new Date() ||
    stored.tokenHash !== hashRefresh(refreshToken)
  ) {
    throw ApiError.unauthorized("Refresh token invalid or expired");
  }

  await prisma.refreshToken.update({
    where: { id: stored.id },
    data: { revoked: true },
  });
  const tokens = await issueTokens(stored.user, req);
  ok(res, tokens, "Token refreshed");
};

export const logout = async (req: Request, res: Response) => {
  await prisma.refreshToken.updateMany({
    where: { userId: req.auth!.sub, revoked: false },
    data: { revoked: true },
  });
  ok(res, { ok: true }, "Logged out");
};

export const me = async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.auth!.sub },
    select: {
      id: true,
      name: true,
      phone: true,
      email: true,
      role: true,
      branchId: true,
      photoUrl: true,
      designation: true,
      tenant: { select: { id: true, name: true, slug: true, logoUrl: true, isPlatform: true } },
      branch: { select: { id: true, name: true, code: true } },
    },
  });
  if (!user) throw ApiError.notFound("User not found");
  ok(res, user);
};

// ─── Password reset via OTP ───────────────────────────────

export const forgotPassword = async (req: Request, res: Response) => {
  const { phone } = req.body as { phone: string };
  const user = await prisma.user.findFirst({ where: { phone, deletedAt: null } });
  if (!user) return ok(res, { sent: true }, "If the number exists, an OTP has been sent");

  const code = numericOtp(6);
  await prisma.otp.create({
    data: {
      userId: user.id,
      phone,
      code,
      purpose: "PASSWORD_RESET",
      expiresAt: dayjs().add(10, "minute").toDate(),
    },
  });
  await notify({
    tenantId: user.tenantId,
    to: phone,
    body: `Your DMS password reset code is ${code}. Valid for 10 minutes.`,
    relatedTo: "PASSWORD_RESET",
  });

  ok(res, { sent: true }, "OTP sent");
};

export const resetPassword = async (req: Request, res: Response) => {
  const { phone, otp, newPassword } = req.body as {
    phone: string;
    otp: string;
    newPassword: string;
  };

  const record = await prisma.otp.findFirst({
    where: { phone, code: otp, purpose: "PASSWORD_RESET", used: false },
    orderBy: { createdAt: "desc" },
  });
  if (!record || record.expiresAt < new Date()) {
    throw ApiError.badRequest("Invalid or expired OTP");
  }

  const user = await prisma.user.findFirst({ where: { phone, deletedAt: null } });
  if (!user) throw ApiError.notFound("User not found");

  const hash = await hashPassword(newPassword);
  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: hash, failedAttempts: 0, lockedUntil: null },
    }),
    prisma.otp.update({ where: { id: record.id }, data: { used: true } }),
    prisma.refreshToken.updateMany({
      where: { userId: user.id, revoked: false },
      data: { revoked: true },
    }),
  ]);

  ok(res, { reset: true }, "Password updated");
};

// ─── Patient portal OTP (no password) ─────────────────────

export const patientRequestOtp = async (req: Request, res: Response) => {
  const { phone, tenantSlug } = req.body as { phone: string; tenantSlug: string };
  const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
  if (!tenant) throw ApiError.notFound("Clinic not found");

  const patient = await prisma.patient.findFirst({
    where: { tenantId: tenant.id, phone, deletedAt: null },
  });
  if (!patient) {
    return ok(res, { sent: true }, "If the patient exists, an OTP has been sent");
  }

  const code = numericOtp(6);
  await prisma.otp.create({
    data: {
      phone,
      code,
      purpose: "PATIENT_PORTAL",
      expiresAt: dayjs().add(10, "minute").toDate(),
    },
  });
  await notify({
    tenantId: tenant.id,
    to: phone,
    body: `Your ${tenant.name} portal login code is ${code}. Valid for 10 minutes.`,
    relatedTo: "PATIENT_PORTAL_OTP",
  });

  ok(res, { sent: true }, "OTP sent");
};

export const patientVerifyOtp = async (req: Request, res: Response) => {
  const { phone, tenantSlug, otp } = req.body as { phone: string; tenantSlug: string; otp: string };

  const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
  if (!tenant) throw ApiError.notFound("Clinic not found");

  const record = await prisma.otp.findFirst({
    where: { phone, code: otp, purpose: "PATIENT_PORTAL", used: false },
    orderBy: { createdAt: "desc" },
  });
  if (!record || record.expiresAt < new Date()) {
    throw ApiError.badRequest("Invalid or expired OTP");
  }

  const patient = await prisma.patient.findFirst({
    where: { tenantId: tenant.id, phone, deletedAt: null },
  });
  if (!patient) throw ApiError.notFound("Patient not found");

  await prisma.otp.update({ where: { id: record.id }, data: { used: true } });

  const tokenId = crypto.randomUUID();
  const accessToken = signAccessToken({
    sub: patient.id,
    tenantId: tenant.id,
    role: "PATIENT",
  });
  const refreshToken = signRefreshToken({ sub: patient.id, tokenId });

  ok(res, {
    accessToken,
    refreshToken,
    patient: {
      id: patient.id,
      name: patient.name,
      phone: patient.phone,
      patientCode: patient.patientCode,
      tenantSlug: tenant.slug,
    },
  }, "OTP verified");
};

// ─── Self-service profile management ──────────────────────

export const updateMe = async (req: Request, res: Response) => {
  const body = req.body as { name?: string; email?: string | null; photoUrl?: string | null };
  const user = await prisma.user.findUnique({ where: { id: req.auth!.sub } });
  if (!user) throw ApiError.notFound("User not found");

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      name: body.name !== undefined ? body.name.trim() : undefined,
      email: body.email !== undefined ? (body.email || null) : undefined,
      photoUrl: body.photoUrl !== undefined ? (body.photoUrl || null) : undefined,
    },
    select: {
      id: true, name: true, phone: true, email: true, role: true,
      branchId: true, photoUrl: true, designation: true,
      tenant: { select: { id: true, name: true, slug: true, logoUrl: true, isPlatform: true } },
      branch: { select: { id: true, name: true, code: true } },
    },
  });

  ok(res, updated, "Profile updated");
};

export const changePassword = async (req: Request, res: Response) => {
  const { currentPassword, newPassword } = req.body as { currentPassword: string; newPassword: string };
  const user = await prisma.user.findUnique({ where: { id: req.auth!.sub } });
  if (!user) throw ApiError.notFound("User not found");

  const valid = await verifyPassword(currentPassword, user.passwordHash);
  if (!valid) throw ApiError.badRequest("Current password is incorrect");
  if (currentPassword === newPassword) {
    throw ApiError.badRequest("New password must be different from the current password");
  }

  const passwordHash = await hashPassword(newPassword);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash },
  });

  await prisma.refreshToken.updateMany({
    where: { userId: user.id, revoked: false },
    data: { revoked: true },
  });

  ok(res, { ok: true }, "Password changed — other sessions signed out");
};
