-- Phase 3 hardening: add the database-level safety nets that the schema
-- comments referenced but were not actually created in the first migration.
--
-- 1. Bed-allocation partial unique — at most one open allocation per bed.
--    Without this, two concurrent admit requests can both pass the
--    "allocations.length === 0" application-level check and stack on the
--    same bed.
--
-- 2. Stock-batch CHECK qtyOnHand >= 0 — defence in depth in case any future
--    code path bypasses the applyMovement() helper.
--
-- 3. IpdCharge dedupe partial unique — prevents the daily-bed-charge cron
--    from double-charging on a server restart (same admission, same date,
--    BED type, no refId).
--
-- 4. Appointment slot-overlap protection — implemented as a partial unique
--    on (doctorId, slotStart) for non-cancelled rows. A true tsrange
--    EXCLUDE would be stronger but Prisma migrations don't introspect it
--    cleanly; this index covers the most common collision (two patients
--    booked at the exact same minute, the EXCLUDE constraint that the
--    schema comment promised but was never created).

-- 1. One open BedAllocation per bed
CREATE UNIQUE INDEX IF NOT EXISTS "bed_allocations_bed_open_uniq"
  ON "bed_allocations" ("bedId")
  WHERE "toTs" IS NULL;

-- 2. Stock can never go negative
ALTER TABLE "medicine_batches"
  ADD CONSTRAINT "medicine_batches_qty_nonneg"
  CHECK ("qtyOnHand" >= 0);

-- 3. One BED daily charge per (admission, date)
CREATE UNIQUE INDEX IF NOT EXISTS "ipd_charges_bed_daily_uniq"
  ON "ipd_charges" ("admissionId", "chargeDate")
  WHERE "chargeType" = 'BED' AND "refId" IS NULL;

-- 4. One non-cancelled appointment per (tenant, doctor, slotStart)
CREATE UNIQUE INDEX IF NOT EXISTS "appointments_doctor_slot_active_uniq"
  ON "appointments" ("tenantId", "doctorId", "slotStart")
  WHERE "status" NOT IN ('CANCELLED', 'NO_SHOW');
