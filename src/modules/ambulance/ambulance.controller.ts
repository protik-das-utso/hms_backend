import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import dayjs from "dayjs";
import { prisma } from "../../config/db";
import { ok, created, paginate } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import { getPagination } from "../../utils/pagination";
import { createInvoice } from "../../utils/invoiceBuilder";

const D = (n: number | string) => new Prisma.Decimal(n);

// ── Vehicles ────────────────────────────────────────────────────

export const listVehicles = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const rows = await prisma.ambulance.findMany({
    where: { tenantId, deletedAt: null },
    orderBy: { vehicleNumber: "asc" },
    include: { branch: { select: { id: true, name: true } } },
  });
  ok(res, rows);
};

export const createVehicle = async (req: Request, res: Response) => {
  const b = req.body as Record<string, unknown>;
  try {
    const v = await prisma.ambulance.create({
      data: {
        tenantId: req.auth!.tenantId,
        branchId: (b.branchId as string) || null,
        vehicleNumber: b.vehicleNumber as string,
        type: (b.type as Prisma.AmbulanceCreateInput["type"]) ?? "NON_AC",
        driverName: (b.driverName as string) || null,
        driverPhone: (b.driverPhone as string) || null,
        baseRate: D((b.baseRate as number) ?? 0),
        perKmRate: D((b.perKmRate as number) ?? 0),
        fuelType: (b.fuelType as string) || null,
        notes: (b.notes as string) || null,
        isActive: (b.isActive as boolean) ?? true,
      },
    });
    created(res, v, "Vehicle added");
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw ApiError.conflict("Vehicle number already exists");
    }
    throw err;
  }
};

export const updateVehicle = async (req: Request, res: Response) => {
  const v = await prisma.ambulance.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId, deletedAt: null },
  });
  if (!v) throw ApiError.notFound("Vehicle not found");
  const b = req.body as Record<string, unknown>;
  const data: Prisma.AmbulanceUpdateInput = {};
  if (b.branchId !== undefined) data.branch = b.branchId ? { connect: { id: b.branchId as string } } : { disconnect: true };
  if (b.vehicleNumber !== undefined) data.vehicleNumber = b.vehicleNumber as string;
  if (b.type !== undefined) data.type = b.type as Prisma.AmbulanceUpdateInput["type"];
  if (b.driverName !== undefined) data.driverName = (b.driverName as string) || null;
  if (b.driverPhone !== undefined) data.driverPhone = (b.driverPhone as string) || null;
  if (b.baseRate !== undefined) data.baseRate = D(b.baseRate as number);
  if (b.perKmRate !== undefined) data.perKmRate = D(b.perKmRate as number);
  if (b.fuelType !== undefined) data.fuelType = (b.fuelType as string) || null;
  if (b.notes !== undefined) data.notes = (b.notes as string) || null;
  if (b.isActive !== undefined) data.isActive = b.isActive as boolean;
  const updated = await prisma.ambulance.update({ where: { id: v.id }, data });
  ok(res, updated, "Vehicle updated");
};

export const archiveVehicle = async (req: Request, res: Response) => {
  const v = await prisma.ambulance.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId, deletedAt: null },
  });
  if (!v) throw ApiError.notFound("Vehicle not found");
  await prisma.ambulance.update({ where: { id: v.id }, data: { deletedAt: new Date(), isActive: false } });
  ok(res, { ok: true }, "Vehicle archived");
};

// ── Trips ───────────────────────────────────────────────────────

export const listTrips = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const { page, pageSize, skip, take } = getPagination(req);
  const status = req.query.status as string | undefined;
  const ambulanceId = req.query.ambulanceId as string | undefined;
  const q = (req.query.q as string | undefined)?.trim();

  const where: Prisma.AmbulanceTripWhereInput = {
    tenantId,
    ...(status ? { status: status as Prisma.AmbulanceTripWhereInput["status"] } : {}),
    ...(ambulanceId ? { ambulanceId } : {}),
    ...(q
      ? {
          OR: [
            { callerName: { contains: q, mode: "insensitive" } },
            { callerPhone: { contains: q } },
            { pickup: { contains: q, mode: "insensitive" } },
            { destination: { contains: q, mode: "insensitive" } },
            { patient: { name: { contains: q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.ambulanceTrip.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take,
      include: {
        ambulance: { select: { id: true, vehicleNumber: true, type: true, driverName: true } },
        patient: { select: { id: true, name: true, patientCode: true } },
      },
    }),
    prisma.ambulanceTrip.count({ where }),
  ]);
  ok(res, rows, "OK", paginate(page, pageSize, total));
};

export const dispatchTrip = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const userId = req.auth!.sub;
  const b = req.body as {
    ambulanceId: string;
    patientId?: string;
    admissionId?: string;
    callerName?: string;
    callerPhone?: string;
    pickup: string;
    destination: string;
    notes?: string;
  };
  const veh = await prisma.ambulance.findFirst({
    where: { id: b.ambulanceId, tenantId, deletedAt: null, isActive: true },
  });
  if (!veh) throw ApiError.notFound("Vehicle not found or inactive");
  // Refuse to dispatch a vehicle already on a trip — drivers can only run
  // one trip at a time. If a clinic operates multiple shifts the operator
  // should mark previous trip COMPLETED first.
  const busy = await prisma.ambulanceTrip.findFirst({
    where: { tenantId, ambulanceId: b.ambulanceId, status: { in: ["DISPATCHED", "EN_ROUTE"] } },
  });
  if (busy) throw ApiError.conflict("Vehicle is already on an active trip");

  const trip = await prisma.ambulanceTrip.create({
    data: {
      tenantId,
      ambulanceId: b.ambulanceId,
      patientId: b.patientId ?? null,
      admissionId: b.admissionId ?? null,
      callerName: b.callerName ?? null,
      callerPhone: b.callerPhone ?? null,
      pickup: b.pickup,
      destination: b.destination,
      status: "DISPATCHED",
      notes: b.notes ?? null,
      createdById: userId,
    },
  });
  created(res, trip, "Trip dispatched");
};

export const startTrip = async (req: Request, res: Response) => {
  const t = await prisma.ambulanceTrip.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId },
  });
  if (!t) throw ApiError.notFound("Trip not found");
  if (t.status !== "DISPATCHED") throw ApiError.badRequest("Trip is not in DISPATCHED state");
  const updated = await prisma.ambulanceTrip.update({
    where: { id: t.id },
    data: { status: "EN_ROUTE", startedAt: new Date() },
  });
  ok(res, updated, "Trip started");
};

/**
 * Complete a trip — captures distance, computes fee (base + per-km), and
 * either writes an IpdCharge row (if admissionId) or creates a standalone
 * MIXED invoice via invoiceBuilder.
 */
export const completeTrip = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const userId = req.auth!.sub;
  const tripId = String(req.params.id);
  const b = req.body as {
    distanceKm: number;
    feeOverride?: number;
    initialPayment?: {
      amount: number;
      method: "CASH" | "BKASH" | "NAGAD" | "ROCKET" | "CARD" | "BANK_TRANSFER";
      referenceNo?: string;
    };
  };

  const result = await prisma.$transaction(async (tx) => {
    const trip = await tx.ambulanceTrip.findFirst({
      where: { id: tripId, tenantId },
      include: { ambulance: true, patient: true },
    });
    if (!trip) throw ApiError.notFound("Trip not found");
    if (trip.status === "COMPLETED" || trip.status === "CANCELLED") {
      throw ApiError.badRequest(`Trip is already ${trip.status.toLowerCase()}`);
    }
    const distanceKm = b.distanceKm;
    if (!Number.isFinite(distanceKm) || distanceKm < 0) throw ApiError.badRequest("Valid distance required");

    const calcFee = Number(trip.ambulance.baseRate) + distanceKm * Number(trip.ambulance.perKmRate);
    const totalFee = b.feeOverride != null ? b.feeOverride : calcFee;

    const updated = await tx.ambulanceTrip.update({
      where: { id: trip.id },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        distanceKm: D(distanceKm),
        totalFee: D(totalFee),
      },
    });

    // Bill it
    if (trip.admissionId) {
      const admission = await tx.admission.findFirst({
        where: { id: trip.admissionId, tenantId, status: "ADMITTED" },
      });
      if (admission && totalFee > 0) {
        await tx.ipdCharge.create({
          data: {
            tenantId,
            admissionId: trip.admissionId,
            chargeDate: dayjs().startOf("day").toDate(),
            chargeType: "OTHER",
            description: `Ambulance ${trip.ambulance.vehicleNumber} — ${trip.pickup} → ${trip.destination}`,
            qty: 1,
            unitPrice: D(totalFee),
            amount: D(totalFee),
            refTable: "ambulance_trips",
            refId: trip.id,
            createdById: userId,
          },
        });
      }
    } else if (trip.patientId && totalFee > 0) {
      const invoice = await createInvoice(
        {
          tenantId,
          branchId: trip.ambulance.branchId ?? (await tx.branch.findFirst({ where: { tenantId } }))!.id,
          patientId: trip.patientId,
          kind: "MIXED",
          collectedById: userId,
          initialPayment: b.initialPayment,
          lines: [{
            lineType: "OTHER",
            description: `Ambulance trip — ${trip.pickup} → ${trip.destination}`,
            unitPrice: totalFee,
            qty: 1,
            refTable: "ambulance_trips",
            refId: trip.id,
          }],
        },
        tx
      );
      await tx.ambulanceTrip.update({ where: { id: trip.id }, data: { invoiceId: invoice.id } });
    }

    return updated;
  });

  ok(res, result, "Trip completed");
};

export const cancelTrip = async (req: Request, res: Response) => {
  const t = await prisma.ambulanceTrip.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId },
  });
  if (!t) throw ApiError.notFound("Trip not found");
  if (t.status === "COMPLETED") throw ApiError.badRequest("Cannot cancel a completed trip");
  const updated = await prisma.ambulanceTrip.update({
    where: { id: t.id },
    data: { status: "CANCELLED", completedAt: new Date() },
  });
  ok(res, updated, "Trip cancelled");
};

