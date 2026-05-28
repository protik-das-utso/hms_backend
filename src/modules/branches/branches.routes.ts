import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRoles } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { UserRole } from "@prisma/client";
import { prisma } from "../../config/db";
import { ApiError } from "../../utils/ApiError";
import { ok, created } from "../../utils/apiResponse";
import { assertQuota } from "../../utils/quota";

export const branchesRouter = Router();

const schema = z.object({
  name: z.string().min(2).max(150),
  code: z.string().min(2).max(30),
  address: z.string().optional(),
  phone: z.string().max(20).optional(),
  email: z.string().email().optional().or(z.literal("")),
});

branchesRouter.use(authenticate);

branchesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const rows = await prisma.branch.findMany({
      where: { tenantId: req.auth!.tenantId, isActive: true },
      orderBy: { name: "asc" },
    });
    ok(res, rows);
  })
);

branchesRouter.post(
  "/",
  requireRoles(UserRole.SUPER_ADMIN),
  validate(schema),
  asyncHandler(async (req, res) => {
    await assertQuota(req.auth!.tenantId, "branches");
    const body = req.body as Record<string, unknown>;
    const row = await prisma.branch.create({
      data: {
        tenantId: req.auth!.tenantId,
        name: body.name as string,
        code: body.code as string,
        address: (body.address as string) || null,
        phone: (body.phone as string) || null,
        email: (body.email as string) || null,
      },
    });
    created(res, row, "Branch created");
  })
);

branchesRouter.put(
  "/:id",
  requireRoles(UserRole.SUPER_ADMIN),
  validate(schema.partial()),
  asyncHandler(async (req, res) => {
    const found = await prisma.branch.findFirst({
      where: { id: String(req.params.id), tenantId: req.auth!.tenantId },
    });
    if (!found) throw ApiError.notFound("Branch not found");
    const row = await prisma.branch.update({ where: { id: found.id }, data: req.body });
    ok(res, row, "Branch updated");
  })
);

branchesRouter.delete(
  "/:id",
  requireRoles(UserRole.SUPER_ADMIN),
  asyncHandler(async (req, res) => {
    const found = await prisma.branch.findFirst({
      where: { id: String(req.params.id), tenantId: req.auth!.tenantId },
    });
    if (!found) throw ApiError.notFound("Branch not found");
    await prisma.branch.update({ where: { id: found.id }, data: { isActive: false } });
    ok(res, { ok: true }, "Branch deactivated");
  })
);

