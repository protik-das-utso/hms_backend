import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import dayjs from "dayjs";
import { UserRole } from "@prisma/client";
import { prisma } from "../../config/db";
import { created } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import { signAccessToken, signRefreshToken } from "../../utils/jwt";
import crypto from "crypto";

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

/**
 * Public tenant signup. Creates:
 *   - Tenant with the requested name + slug
 *   - Subscription in TRIAL status (14 days, full Small-plan limits)
 *   - Initial SUPER_ADMIN user
 *   - Initial Branch (one default branch per tenant)
 * Returns access + refresh tokens so the new admin lands in the app already
 * logged in.
 *
 * No payment required up front — out-of-band subscription model.
 */
export const signup = async (req: Request, res: Response) => {
  const body = req.body as {
    clinicName: string;
    contactName: string;
    phone: string;
    email?: string;
    password: string;
    branchName?: string;
    planCode?: string;
  };

  // Slug must be globally unique. Generate from clinic name; if taken, append random suffix.
  let slug = slugify(body.clinicName);
  if (!slug) slug = `clinic-${crypto.randomBytes(3).toString("hex")}`;
  let attempt = 0;
  while (true) {
    const taken = await prisma.tenant.findUnique({ where: { slug }, select: { id: true } });
    if (!taken) break;
    attempt++;
    if (attempt > 5) throw ApiError.conflict("Could not allocate a unique clinic slug — try a different name");
    slug = `${slugify(body.clinicName)}-${crypto.randomBytes(2).toString("hex")}`;
  }

  // Phone is globally unique within a tenant — but we want phone unique across
  // the platform so the same person can't sign up twice. Soft-check.
  const phoneCollision = await prisma.user.findFirst({
    where: { phone: body.phone, deletedAt: null },
    select: { id: true },
  });
  if (phoneCollision) {
    throw ApiError.conflict("This phone number is already registered. Try logging in instead.");
  }

  // Pick the requested plan, or default to TRIAL config.
  const planCode = (body.planCode || "TRIAL").toUpperCase();
  const plan = await prisma.subscriptionPlanConfig.findUnique({ where: { code: planCode } });
  if (!plan) throw ApiError.badRequest(`Plan ${planCode} not found — contact support`);

  const trialDays = 14;
  const trialEnd = dayjs().add(trialDays, "day").toDate();
  const passwordHash = await bcrypt.hash(body.password, 10);

  const result = await prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({
      data: {
        name: body.clinicName.trim(),
        slug,
        contactEmail: body.email || null,
        contactPhone: body.phone || null,
      },
    });

    const branch = await tx.branch.create({
      data: {
        tenantId: tenant.id,
        name: body.branchName?.trim() || "Main branch",
        code: "MAIN",
        phone: body.phone,
        email: body.email || null,
      },
    });

    await tx.subscription.create({
      data: {
        tenantId: tenant.id,
        planConfigId: plan.id,
        plan: planCode.match(/^(TRIAL|SMALL|MEDIUM|ENTERPRISE)$/) ? (planCode as any) : "TRIAL",
        status: "TRIAL",
        monthlyPrice: plan.monthlyPrice,
        maxBranches: plan.maxBranches,
        maxUsers: plan.maxUsers,
        maxPatientsMonth: plan.maxPatientsMonth,
        maxStorageGb: plan.maxStorageGb,
        billingCycleStart: new Date(),
        billingCycleEnd: trialEnd,
        trialEndsAt: trialEnd,
        nextBillingDate: trialEnd,
      },
    });

    await tx.subscriptionEvent.create({
      data: {
        tenantId: tenant.id,
        eventType: "SIGNUP",
        notes: `Signup via web. Trial until ${dayjs(trialEnd).format("YYYY-MM-DD")}.`,
      },
    });

    const user = await tx.user.create({
      data: {
        tenantId: tenant.id,
        branchId: branch.id,
        name: body.contactName.trim(),
        phone: body.phone,
        email: body.email || null,
        passwordHash,
        role: UserRole.SUPER_ADMIN,
        designation: "Owner",
      },
    });

    return { tenant, user, branch };
  });

  const access = signAccessToken({
    sub: result.user.id,
    tenantId: result.tenant.id,
    role: result.user.role,
    branchId: result.branch.id,
  });
  const tokenId = crypto.randomBytes(16).toString("hex");
  const refresh = signRefreshToken({ sub: result.user.id, tokenId });
  const tokenHash = crypto.createHash("sha256").update(refresh).digest("hex");
  await prisma.refreshToken.create({
    data: {
      userId: result.user.id,
      tokenHash,
      expiresAt: dayjs().add(30, "day").toDate(),
    },
  });

  created(
    res,
    {
      accessToken: access,
      refreshToken: refresh,
      user: {
        id: result.user.id,
        name: result.user.name,
        phone: result.user.phone,
        role: result.user.role,
      },
      tenant: {
        id: result.tenant.id,
        name: result.tenant.name,
        slug: result.tenant.slug,
      },
      // Echo back the plan the server actually saved, so the frontend can
      // show what was created (catches any code/UI mismatch immediately).
      plan: { code: plan.code, name: plan.name },
      trialEndsAt: trialEnd,
    },
    `Welcome — your ${plan.name} trial is active`
  );
};

export const checkSlug = async (req: Request, res: Response) => {
  const slug = slugify(String(req.query.slug || ""));
  if (!slug) return res.json({ status: "success", data: { slug, available: false } });
  const t = await prisma.tenant.findUnique({ where: { slug }, select: { id: true } });
  res.json({ status: "success", data: { slug, available: !t } });
};
