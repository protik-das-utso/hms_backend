import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../../config/db";
import { ok, created } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";

export const listForAdmission = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const a = await prisma.admission.findFirst({ where: { id: String(req.params.admissionId), tenantId } });
  if (!a) throw ApiError.notFound("Admission not found");
  const notes = await prisma.nursingNote.findMany({
    where: { tenantId, admissionId: a.id },
    orderBy: { recordedAt: "desc" },
    include: { nurse: { select: { id: true, name: true } } },
  });
  ok(res, notes);
};

export const create = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const nurseId = req.auth!.sub;
  const body = req.body as { admissionId: string; note: string; vitals?: Record<string, unknown> };
  const a = await prisma.admission.findFirst({
    where: { id: body.admissionId, tenantId, status: "ADMITTED" },
  });
  if (!a) throw ApiError.notFound("Active admission not found");
  const n = await prisma.nursingNote.create({
    data: {
      tenantId,
      admissionId: a.id,
      nurseId,
      note: body.note,
      vitals: body.vitals ? (body.vitals as Prisma.InputJsonValue) : undefined,
    },
    include: { nurse: { select: { id: true, name: true } } },
  });
  created(res, n, "Note recorded");
};

