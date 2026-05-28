import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import dayjs from "dayjs";
import { prisma } from "../../config/db";
import { ok, created } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";

const D = (n: number | string) => new Prisma.Decimal(n);

// ── Card catalog ─────────────────────────────────────────────

export const listCards = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const rows = await prisma.healthCard.findMany({
    where: { tenantId },
    orderBy: { discountPercent: "desc" },
  });
  ok(res, rows);
};

export const createCard = async (req: Request, res: Response) => {
  const b = req.body as Record<string, unknown>;
  try {
    const c = await prisma.healthCard.create({
      data: {
        tenantId: req.auth!.tenantId,
        name: b.name as string,
        description: (b.description as string) || null,
        discountPercent: D((b.discountPercent as number) ?? 0),
        monthlyFee: D((b.monthlyFee as number) ?? 0),
        validityDays: (b.validityDays as number) ?? 365,
        isActive: (b.isActive as boolean) ?? true,
      },
    });
    created(res, c, "Card added");
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw ApiError.conflict("A card with that name already exists");
    }
    throw err;
  }
};

export const updateCard = async (req: Request, res: Response) => {
  const c = await prisma.healthCard.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId },
  });
  if (!c) throw ApiError.notFound("Card not found");
  const b = req.body as Record<string, unknown>;
  const data: Prisma.HealthCardUpdateInput = {};
  if (b.name !== undefined) data.name = b.name as string;
  if (b.description !== undefined) data.description = (b.description as string) || null;
  if (b.discountPercent !== undefined) data.discountPercent = D(b.discountPercent as number);
  if (b.monthlyFee !== undefined) data.monthlyFee = D(b.monthlyFee as number);
  if (b.validityDays !== undefined) data.validityDays = b.validityDays as number;
  if (b.isActive !== undefined) data.isActive = b.isActive as boolean;
  const updated = await prisma.healthCard.update({ where: { id: c.id }, data });
  ok(res, updated, "Card updated");
};

// ── Patient ↔ Card assignment ───────────────────────────────

export const getForPatient = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const phc = await prisma.patientHealthCard.findFirst({
    where: { tenantId, patientId: String(req.params.patientId) },
    include: { card: true },
  });
  ok(res, phc);
};

/**
 * Assign or replace a patient's card. Each patient has a single active card
 * (DB-enforced unique on patientId). To switch cards, we update the row.
 */
export const assignToPatient = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const b = req.body as {
    patientId: string;
    cardId: string;
    cardNumber?: string;
    issuedAt?: string;
    notes?: string;
  };

  const [card, patient] = await Promise.all([
    prisma.healthCard.findFirst({ where: { id: b.cardId, tenantId, isActive: true } }),
    prisma.patient.findFirst({ where: { id: b.patientId, tenantId, deletedAt: null } }),
  ]);
  if (!card) throw ApiError.notFound("Card not found or inactive");
  if (!patient) throw ApiError.notFound("Patient not found");

  const issuedAt = b.issuedAt ? new Date(b.issuedAt) : new Date();
  const expiresAt = dayjs(issuedAt).add(card.validityDays, "day").toDate();

  const row = await prisma.patientHealthCard.upsert({
    where: { patientId: b.patientId },
    create: {
      tenantId,
      patientId: b.patientId,
      cardId: card.id,
      cardNumber: b.cardNumber ?? null,
      issuedAt,
      expiresAt,
      isActive: true,
      notes: b.notes ?? null,
    },
    update: {
      cardId: card.id,
      cardNumber: b.cardNumber ?? null,
      issuedAt,
      expiresAt,
      isActive: true,
      notes: b.notes ?? null,
    },
    include: { card: true },
  });
  created(res, row, "Card assigned");
};

export const revokeForPatient = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const row = await prisma.patientHealthCard.findFirst({
    where: { tenantId, patientId: String(req.params.patientId) },
  });
  if (!row) throw ApiError.notFound("Patient has no card");
  await prisma.patientHealthCard.update({
    where: { id: row.id },
    data: { isActive: false },
  });
  ok(res, { ok: true }, "Card revoked");
};

