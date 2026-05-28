import { Request, Response } from "express";
import dayjs from "dayjs";
import { prisma } from "../../config/db";
import { ok } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import { cached } from "../../utils/cache";

/**
 * Public read-only board for the OPD waiting area. Shows for each doctor
 * with appointments today:
 *  - the token currently IN_CONSULT (or last CHECKED_IN if none consulting)
 *  - the next 5 tokens (CHECKED_IN or BOOKED) by token number
 * No auth — clinic stick this on a TV.
 *
 * Accepts ?branchId=X — falls back to tenant's first branch via ?tenantSlug
 * when missing. tenantSlug is required so the public URL is tenant-scoped.
 *
 * Cached 10s in-process. Matches the front-end polling interval — multiple
 * TVs in the waiting room share one DB roundtrip per 10s window. With 40
 * clinics × 2 TVs each polling every 10s, this drops the DB load from
 * 480 hits/min to ~6 hits/min (one per clinic, regardless of TV count).
 */
export const board = async (req: Request, res: Response) => {
  const tenantSlug = (req.query.tenantSlug as string | undefined) ?? "";
  if (!tenantSlug) throw ApiError.badRequest("tenantSlug is required");
  const tenant = await prisma.tenant.findUnique({
    where: { slug: tenantSlug },
    select: { id: true, name: true, isActive: true },
  });
  if (!tenant || !tenant.isActive) throw ApiError.notFound("Clinic not found");
  const branchId = req.query.branchId as string | undefined;
  const doctorId = req.query.doctorId as string | undefined;

  const cacheKey = `tokenboard:${tenant.id}:${branchId ?? "all"}:${doctorId ?? "all"}`;
  const payload = await cached(cacheKey, 10_000, async () => {
    const dayStart = dayjs().startOf("day").toDate();
    const dayEnd = dayjs().endOf("day").toDate();

    const appts = await prisma.appointment.findMany({
      where: {
        tenantId: tenant.id,
        slotStart: { gte: dayStart, lte: dayEnd },
        status: { in: ["BOOKED", "CHECKED_IN", "IN_CONSULT", "COMPLETED"] },
        ...(branchId ? { branchId } : {}),
        ...(doctorId ? { doctorId } : {}),
      },
      orderBy: { tokenNumber: "asc" },
      select: {
        id: true,
        tokenNumber: true,
        status: true,
        slotStart: true,
        doctor: { select: { id: true, name: true, specialization: true } },
      },
    });

    type DoctorBlock = {
      doctorId: string;
      doctorName: string;
      specialization: string | null;
      nowServing: { tokenNumber: number; status: string } | null;
      upcoming: { tokenNumber: number; status: string; slotStart: string }[];
      completed: number;
    };
    const grouped = new Map<string, DoctorBlock>();
    for (const a of appts) {
      let block = grouped.get(a.doctor.id);
      if (!block) {
        block = {
          doctorId: a.doctor.id,
          doctorName: a.doctor.name,
          specialization: a.doctor.specialization,
          nowServing: null,
          upcoming: [],
          completed: 0,
        };
        grouped.set(a.doctor.id, block);
      }
      if (a.status === "IN_CONSULT") {
        // Latest IN_CONSULT wins (multiple shouldn't happen but be defensive).
        block.nowServing = { tokenNumber: a.tokenNumber, status: a.status };
      } else if (a.status === "COMPLETED") {
        block.completed++;
      } else {
        // BOOKED or CHECKED_IN — upcoming
        block.upcoming.push({ tokenNumber: a.tokenNumber, status: a.status, slotStart: a.slotStart.toISOString() });
      }
    }

    // If no IN_CONSULT, treat the lowest CHECKED_IN as "next up".
    for (const b of grouped.values()) {
      if (!b.nowServing) {
        const nextChecked = b.upcoming.find((u) => u.status === "CHECKED_IN");
        if (nextChecked) {
          b.nowServing = { tokenNumber: nextChecked.tokenNumber, status: "CHECKED_IN" };
          b.upcoming = b.upcoming.filter((u) => u !== nextChecked);
        }
      }
      b.upcoming = b.upcoming.slice(0, 5);
    }

    return {
      tenant: { name: tenant.name },
      branchId: branchId ?? null,
      fetchedAt: new Date().toISOString(),
      doctors: Array.from(grouped.values()).sort((a, b) => a.doctorName.localeCompare(b.doctorName)),
    };
  });

  ok(res, payload);
};
