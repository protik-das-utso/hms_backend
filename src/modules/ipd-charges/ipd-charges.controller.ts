import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import dayjs from "dayjs";
import { prisma } from "../../config/db";
import { ok, created } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";

export const listForAdmission = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const admissionId = String(req.params.admissionId);
  const a = await prisma.admission.findFirst({ where: { id: admissionId, tenantId } });
  if (!a) throw ApiError.notFound("Admission not found");
  const charges = await prisma.ipdCharge.findMany({
    where: { tenantId, admissionId },
    orderBy: [{ chargeDate: "asc" }, { createdAt: "asc" }],
  });
  ok(res, charges);
};

/**
 * Ad-hoc charge entry — used for one-off items (consumables, procedures,
 * paid investigations done outside the lab flow). Pharmacy/lab/doctor visits
 * write their own charges as part of their own create flows.
 */
export const create = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const userId = req.auth!.sub;
  const body = req.body as {
    admissionId: string;
    chargeDate?: string;
    chargeType:
      | "BED"
      | "DOCTOR_VISIT"
      | "NURSING"
      | "MEDICINE"
      | "PROCEDURE"
      | "CONSUMABLE"
      | "INVESTIGATION"
      | "OTHER";
    description: string;
    qty?: number;
    unitPrice: number;
    refTable?: string;
    refId?: string;
  };

  const admission = await prisma.admission.findFirst({
    where: { id: body.admissionId, tenantId, status: "ADMITTED" },
  });
  if (!admission) throw ApiError.notFound("Active admission not found");
  const qty = body.qty ?? 1;
  if (qty < 1) throw ApiError.badRequest("Qty must be ≥ 1");
  const amount = new Prisma.Decimal(body.unitPrice).times(qty);

  const c = await prisma.ipdCharge.create({
    data: {
      tenantId,
      admissionId: body.admissionId,
      chargeDate: body.chargeDate ? dayjs(body.chargeDate).startOf("day").toDate() : dayjs().startOf("day").toDate(),
      chargeType: body.chargeType,
      description: body.description,
      qty,
      unitPrice: new Prisma.Decimal(body.unitPrice),
      amount,
      refTable: body.refTable ?? null,
      refId: body.refId ?? null,
      createdById: userId,
    },
  });
  created(res, c, "Charge added");
};

export const remove = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const c = await prisma.ipdCharge.findFirst({
    where: { id: String(req.params.id), tenantId },
    include: { admission: { select: { status: true } } },
  });
  if (!c) throw ApiError.notFound("Charge not found");
  if (c.admission.status !== "ADMITTED") {
    throw ApiError.conflict("Cannot remove a charge from a discharged admission");
  }
  await prisma.ipdCharge.delete({ where: { id: c.id } });
  ok(res, { ok: true }, "Charge removed");
};

