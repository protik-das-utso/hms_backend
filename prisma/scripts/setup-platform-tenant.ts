/**
 * One-off setup script: creates or promotes the platform tenant + initial
 * platform SUPER_ADMIN. Safe to run multiple times — idempotent.
 *
 * Usage:
 *   npx tsx prisma/scripts/setup-platform-tenant.ts
 *
 * The platform tenant's SUPER_ADMIN users can manage every other tenant
 * (plans, subscriptions, suspensions). Set credentials via env vars or take
 * the defaults below.
 */
import { Prisma, PrismaClient, UserRole } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();
const D = (n: number) => new Prisma.Decimal(n);

const PLATFORM_SLUG = process.env.PLATFORM_SLUG ?? "dms-platform";
const PLATFORM_NAME = process.env.PLATFORM_NAME ?? "DMS Platform";
const ADMIN_NAME = process.env.PLATFORM_ADMIN_NAME ?? "Platform Admin";
const ADMIN_PHONE = process.env.PLATFORM_ADMIN_PHONE ?? "01900000000";
const ADMIN_PASSWORD = process.env.PLATFORM_ADMIN_PASSWORD ?? "platform123";

// Default plan catalogue — seeded only if missing. Same numbers as the
// migration's INSERTs, kept in code so this script can recover if the
// migration's seed step didn't run (or got rolled back) for any reason.
const DEFAULT_PLANS: Array<{
  code: string; name: string; description: string;
  monthlyPrice: number; yearlyPrice: number;
  maxBranches: number; maxUsers: number; maxPatientsMonth: number; maxStorageGb: number;
  sortOrder: number; isPublic: boolean; highlightTag: string | null;
  features: Record<string, boolean>;
}> = [
  {
    code: "TRIAL", name: "Trial (14 days)",
    description: "Free 14-day trial — full Small plan limits.",
    monthlyPrice: 0, yearlyPrice: 0,
    maxBranches: 1, maxUsers: 5, maxPatientsMonth: 100, maxStorageGb: 1,
    sortOrder: 0, isPublic: false, highlightTag: null,
    features: { opd: true, pharmacy: false, ipd: false, radiology: false, bloodbank: false, ambulance: false, ot: false, vaccination: true, hr: false, corporate: false, whitelabel: false, audit_log: false },
  },
  {
    code: "SMALL", name: "Small",
    description: "For single-branch clinics and small diagnostic centres.",
    monthlyPrice: 3000, yearlyPrice: 30000,
    maxBranches: 1, maxUsers: 10, maxPatientsMonth: 500, maxStorageGb: 5,
    sortOrder: 1, isPublic: true, highlightTag: null,
    features: { opd: true, pharmacy: false, ipd: false, radiology: false, bloodbank: false, ambulance: false, ot: false, vaccination: true, hr: false, corporate: false, whitelabel: false, audit_log: false },
  },
  {
    code: "MEDIUM", name: "Medium",
    description: "Multi-branch operations with full pharmacy + IPD modules.",
    monthlyPrice: 8000, yearlyPrice: 80000,
    maxBranches: 3, maxUsers: 30, maxPatientsMonth: 2500, maxStorageGb: 25,
    sortOrder: 2, isPublic: true, highlightTag: "Most popular",
    features: { opd: true, pharmacy: true, ipd: true, radiology: true, bloodbank: false, ambulance: true, ot: false, vaccination: true, hr: true, corporate: true, whitelabel: false, audit_log: true },
  },
  {
    code: "ENTERPRISE", name: "Enterprise",
    description: "Large hospitals with white-label branding and priority support.",
    monthlyPrice: 20000, yearlyPrice: 200000,
    maxBranches: 99, maxUsers: 200, maxPatientsMonth: 20000, maxStorageGb: 100,
    sortOrder: 3, isPublic: true, highlightTag: null,
    features: { opd: true, pharmacy: true, ipd: true, radiology: true, bloodbank: true, ambulance: true, ot: true, vaccination: true, hr: true, corporate: true, whitelabel: true, audit_log: true },
  },
];

async function seedPlansIfMissing() {
  const existingCount = await prisma.subscriptionPlanConfig.count();
  if (existingCount >= DEFAULT_PLANS.length) {
    console.log(`✓ ${existingCount} subscription plans already present.`);
    return;
  }

  for (const p of DEFAULT_PLANS) {
    const existing = await prisma.subscriptionPlanConfig.findUnique({ where: { code: p.code } });
    if (existing) continue;
    await prisma.subscriptionPlanConfig.create({
      data: {
        code: p.code,
        name: p.name,
        description: p.description,
        monthlyPrice: D(p.monthlyPrice),
        yearlyPrice: D(p.yearlyPrice),
        maxBranches: p.maxBranches,
        maxUsers: p.maxUsers,
        maxPatientsMonth: p.maxPatientsMonth,
        maxStorageGb: p.maxStorageGb,
        sortOrder: p.sortOrder,
        isPublic: p.isPublic,
        isActive: true,
        highlightTag: p.highlightTag,
        features: p.features,
      },
    });
    console.log(`  + Seeded plan ${p.code} (${p.name}).`);
  }
}

async function main() {
  console.log("Setting up SaaS platform layer…\n");

  await seedPlansIfMissing();

  console.log("\nSetting up platform tenant…");

  // Find an existing platform tenant, or the one we'll promote, or create one.
  let tenant = await prisma.tenant.findFirst({ where: { isPlatform: true } });

  if (!tenant) {
    tenant = await prisma.tenant.findUnique({ where: { slug: PLATFORM_SLUG } });
    if (tenant) {
      tenant = await prisma.tenant.update({
        where: { id: tenant.id },
        data: { isPlatform: true, name: PLATFORM_NAME },
      });
      console.log(`✓ Promoted existing tenant "${tenant.name}" (${tenant.slug}) to platform.`);
    } else {
      tenant = await prisma.tenant.create({
        data: {
          name: PLATFORM_NAME,
          slug: PLATFORM_SLUG,
          isPlatform: true,
          isActive: true,
          contactEmail: "platform@dms.local",
        },
      });
      console.log(`✓ Created platform tenant "${tenant.name}" (${tenant.slug}).`);
    }
  } else {
    console.log(`✓ Platform tenant already exists: ${tenant.name} (${tenant.slug}).`);
  }

  // Create a default main branch so the user can be assigned a branch.
  let branch = await prisma.branch.findFirst({ where: { tenantId: tenant.id } });
  if (!branch) {
    branch = await prisma.branch.create({
      data: {
        tenantId: tenant.id,
        name: "Platform HQ",
        code: "HQ",
      },
    });
    console.log(`✓ Created branch "${branch.name}".`);
  }

  const existingAdmin = await prisma.user.findFirst({
    where: { tenantId: tenant.id, phone: ADMIN_PHONE, deletedAt: null },
  });

  if (existingAdmin) {
    if (existingAdmin.role !== UserRole.SUPER_ADMIN) {
      await prisma.user.update({
        where: { id: existingAdmin.id },
        data: { role: UserRole.SUPER_ADMIN, isActive: true },
      });
      console.log(`✓ Promoted existing user ${existingAdmin.name} to SUPER_ADMIN.`);
    } else {
      console.log(`✓ Platform admin already exists: ${existingAdmin.name} (${existingAdmin.phone}).`);
    }
  } else {
    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    const admin = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        branchId: branch.id,
        name: ADMIN_NAME,
        phone: ADMIN_PHONE,
        passwordHash,
        role: UserRole.SUPER_ADMIN,
        designation: "Platform Admin",
        isActive: true,
      },
    });
    console.log(`✓ Created platform admin: ${admin.name} (${admin.phone}).`);
  }

  console.log("\n✨  Platform setup complete.\n");
  console.log(`   Login URL:    http://localhost:3000/login`);
  console.log(`   Phone:        ${ADMIN_PHONE}`);
  console.log(`   Password:     ${ADMIN_PASSWORD}`);
  console.log(`   After login:  open /platform in the sidebar.\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
