import { Router, Request, Response } from "express";
import { authenticate } from "../../middleware/auth";
import { asyncHandler } from "../../utils/asyncHandler";
import { ok } from "../../utils/apiResponse";
import { prisma } from "../../config/db";

export const searchRouter = Router();

searchRouter.use(authenticate);

const TAKE_PER_GROUP = 5;

/**
 * Global topbar search. Returns grouped, top-N results across the entities a
 * staff user typically jumps to — patient by name/phone/code, invoice by
 * number, test order by number/barcode, appointment by patient + today.
 *
 * Tenant-scoped via req.auth.tenantId. Empty `q` returns nothing.
 */
searchRouter.get(
  "/global",
  asyncHandler(async (req: Request, res: Response) => {
    const q = String(req.query.q ?? "").trim();
    if (!q || q.length < 2) {
      return ok(res, { patients: [], invoices: [], orders: [], appointments: [] });
    }
    const tenantId = req.auth!.tenantId;
    const insensitive = "insensitive" as const;

    const [patients, invoices, orders, appointments] = await Promise.all([
      // Patients — name (ILIKE), phone substring, NID, patient code
      prisma.patient.findMany({
        where: {
          tenantId,
          deletedAt: null,
          OR: [
            { name: { contains: q, mode: insensitive } },
            { phone: { contains: q } },
            { nid: { contains: q } },
            { patientCode: { contains: q, mode: insensitive } },
          ],
        },
        select: { id: true, patientCode: true, name: true, phone: true, gender: true },
        take: TAKE_PER_GROUP,
        orderBy: { createdAt: "desc" },
      }),

      // Invoices — number (most common search), or patient name/phone substring.
      prisma.invoice.findMany({
        where: {
          tenantId,
          OR: [
            { invoiceNumber: { contains: q, mode: insensitive } },
            { patient: { name: { contains: q, mode: insensitive } } },
            { patient: { phone: { contains: q } } },
          ],
        },
        select: {
          id: true,
          invoiceNumber: true,
          totalAmount: true,
          dueAmount: true,
          status: true,
          createdAt: true,
          patient: { select: { id: true, name: true } },
        },
        take: TAKE_PER_GROUP,
        orderBy: { createdAt: "desc" },
      }),

      // Test orders — order number or sample barcode (lab techs scan these).
      prisma.testOrder.findMany({
        where: {
          tenantId,
          OR: [
            { orderNumber: { contains: q, mode: insensitive } },
            { items: { some: { barcode: { contains: q, mode: insensitive } } } },
            { patient: { name: { contains: q, mode: insensitive } } },
          ],
        },
        select: {
          id: true,
          orderNumber: true,
          status: true,
          createdAt: true,
          patient: { select: { id: true, name: true } },
        },
        take: TAKE_PER_GROUP,
        orderBy: { createdAt: "desc" },
      }),

      // Appointments — match patient name/phone or doctor name.
      prisma.appointment.findMany({
        where: {
          tenantId,
          status: { notIn: ["CANCELLED", "NO_SHOW"] },
          OR: [
            { patient: { name: { contains: q, mode: insensitive } } },
            { patient: { phone: { contains: q } } },
            { doctor: { name: { contains: q, mode: insensitive } } },
          ],
        },
        select: {
          id: true,
          slotStart: true,
          tokenNumber: true,
          status: true,
          patient: { select: { id: true, name: true } },
          doctor: { select: { name: true } },
        },
        take: TAKE_PER_GROUP,
        orderBy: { slotStart: "desc" },
      }),
    ]);

    ok(res, {
      patients: patients.map((p) => ({
        id: p.id,
        href: `/patients/${p.id}`,
        primary: p.name,
        secondary: `${p.patientCode} · ${p.phone}`,
      })),
      invoices: invoices.map((i) => ({
        id: i.id,
        href: `/billing/${i.id}`,
        primary: i.invoiceNumber,
        secondary: `${i.patient.name} · ${i.status} · ${Number(i.totalAmount).toFixed(0)}`,
      })),
      orders: orders.map((o) => ({
        id: o.id,
        href: `/orders/${o.id}`,
        primary: o.orderNumber,
        secondary: `${o.patient.name} · ${o.status}`,
      })),
      appointments: appointments.map((a) => ({
        id: a.id,
        href: `/appointments/${a.id}`,
        primary: `Token #${a.tokenNumber} — ${a.patient.name}`,
        secondary: `Dr. ${a.doctor.name} · ${a.status}`,
      })),
    });
  })
);
