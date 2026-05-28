import {
  PrismaClient,
  UserRole,
  Gender,
  SubscriptionPlan,
  SubscriptionStatus,
  PaymentMethod,
  BloodGroup,
  BloodComponent,
  BloodBagStatus,
  ScreeningResult,
  AmbulanceType,
  AmbulanceTripStatus,
  WardType,
  BedStatus,
  AdmissionStatus,
  IpdChargeType,
  ExpenseCategory,
  CashCloseStatus,
  PettyCashType,
  FeedbackType,
  FeedbackStatus,
  NoticeAudience,
  EmploymentType,
  PayrollRunStatus,
  PayslipStatus,
  LoanStatus,
  LeaveStatus,
  AttendanceStatus,
  OtBookingStatus,
  AppointmentStatus,
  VisitType,
  BillingCycle,
  SubscriptionInvoiceStatus,
  CorporateClientType,
  CorporateStatementStatus,
  SupportTicketStatus,
  SupportTicketSeverity,
  SupportTicketCategory,
  SupportMessageSide,
} from "@prisma/client";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import dayjs from "dayjs";

const prisma = new PrismaClient();
const hash = (p: string) => bcrypt.hash(p, 10);
const qrToken = () => crypto.randomBytes(24).toString("hex");
const barcode = (i: number) =>
  `SMP-${dayjs().format("YYMMDD")}-${String(i).padStart(5, "0")}`;
const bagNo = (i: number) => `BB-${dayjs().format("YYMM")}-${String(i).padStart(4, "0")}`;
const admNo = (i: number) => `ADM-${dayjs().format("YYMMDD")}-${String(i).padStart(4, "0")}`;

async function main() {
  console.log("\n  🌱  Seeding DMS database (full demo data)...\n");

  // ── Cleanup (delete in FK-safe order) ───────────────
  // Cascade chain from Tenant covers most rows; we still delete
  // a few standalone-looking tables for clarity.
  await prisma.$transaction([
    // SaaS layer (must come before tenant.deleteMany since they reference it)
    prisma.supportTicketMessage.deleteMany(),
    prisma.supportTicket.deleteMany(),
    prisma.subscriptionInvoicePayment.deleteMany(),
    prisma.subscriptionInvoiceLine.deleteMany(),
    prisma.subscriptionInvoice.deleteMany(),
    prisma.corporatePayment.deleteMany(),
    prisma.corporateStatement.deleteMany(),
    prisma.corporateClient.deleteMany(),
    prisma.rolePermission.deleteMany(),
    // Phase D
    prisma.dutyRoster.deleteMany(),
    prisma.dutyShift.deleteMany(),
    prisma.attendance.deleteMany(),
    prisma.leaveRequest.deleteMany(),
    prisma.leaveBalance.deleteMany(),
    prisma.leaveType.deleteMany(),
    prisma.staffLoan.deleteMany(),
    prisma.payslip.deleteMany(),
    prisma.payrollRun.deleteMany(),
    prisma.employmentTerms.deleteMany(),
    // Phase C
    prisma.noticeReceipt.deleteMany(),
    prisma.notice.deleteMany(),
    prisma.smsTemplate.deleteMany(),
    // Phase B
    prisma.patientHealthCard.deleteMany(),
    prisma.healthCard.deleteMany(),
    prisma.patientFeedback.deleteMany(),
    prisma.commissionPayout.deleteMany(),
    prisma.pettyCashEntry.deleteMany(),
    prisma.cashClose.deleteMany(),
    // Phase A
    prisma.otNote.deleteMany(),
    prisma.otBooking.deleteMany(),
    prisma.operatingRoom.deleteMany(),
    prisma.patientVaccination.deleteMany(),
    prisma.vaccine.deleteMany(),
    prisma.ambulanceTrip.deleteMany(),
    prisma.ambulance.deleteMany(),
    prisma.bloodIssue.deleteMany(),
    prisma.bloodScreening.deleteMany(),
    prisma.bloodBag.deleteMany(),
    prisma.bloodDonor.deleteMany(),
    // IPD
    prisma.dischargeSummary.deleteMany(),
    prisma.doctorVisit.deleteMany(),
    prisma.nursingNote.deleteMany(),
    prisma.ipdCharge.deleteMany(),
    prisma.bedAllocation.deleteMany(),
    prisma.admission.deleteMany(),
    prisma.bed.deleteMany(),
    prisma.ward.deleteMany(),
    // Expenses
    prisma.expense.deleteMany(),
    // Pharmacy + medical
    prisma.pharmacySaleItem.deleteMany(),
    prisma.pharmacySale.deleteMany(),
    prisma.stockMovement.deleteMany(),
    prisma.medicineBatch.deleteMany(),
    prisma.supplier.deleteMany(),
    prisma.medicine.deleteMany(),
    prisma.prescriptionItem.deleteMany(),
    prisma.prescription.deleteMany(),
    prisma.diagnosis.deleteMany(),
    prisma.consultation.deleteMany(),
    prisma.appointment.deleteMany(),
    prisma.doctorSchedule.deleteMany(),
    prisma.notification.deleteMany(),
    prisma.payment.deleteMany(),
    prisma.report.deleteMany(),
    prisma.testOrderItem.deleteMany(),
    prisma.testOrder.deleteMany(),
    prisma.invoiceLine.deleteMany(),
    prisma.invoice.deleteMany(),
    prisma.testBranchPrice.deleteMany(),
    prisma.test.deleteMany(),
    prisma.testCategory.deleteMany(),
    prisma.referrer.deleteMany(),
    prisma.patient.deleteMany(),
    prisma.refreshToken.deleteMany(),
    prisma.otp.deleteMany(),
    prisma.subscriptionEvent.deleteMany(),
    prisma.auditLog.deleteMany(),
    prisma.user.deleteMany(),
    prisma.branch.deleteMany(),
    prisma.subscription.deleteMany(),
    prisma.tenant.deleteMany(),
    prisma.icdCode.deleteMany(),
    // Plan catalogue last — no FK to tenant, just standalone master data.
    prisma.subscriptionPlanConfig.deleteMany(),
  ]);

  // ── Subscription plan catalogue ──────────────────
  // Seed the 4 default plans the platform offers. Created BEFORE the tenant
  // so subscriptions can link to a planConfigId. Code values match the
  // SubscriptionPlan enum for legacy lookup.
  console.log("  · seeding subscription plans...");
  const trialPlan = await prisma.subscriptionPlanConfig.create({
    data: {
      code: "TRIAL",
      name: "Trial (14 days)",
      description: "Free 14-day trial — Small plan limits.",
      monthlyPrice: 0,
      yearlyPrice: 0,
      maxBranches: 1, maxUsers: 5, maxPatientsMonth: 100, maxStorageGb: 1,
      sortOrder: 0,
      isPublic: false,
      features: { opd: true, vaccination: true },
    },
  });
  const smallPlan = await prisma.subscriptionPlanConfig.create({
    data: {
      code: "SMALL",
      name: "Small",
      description: "For single-branch clinics and small diagnostic centres.",
      monthlyPrice: 3000,
      yearlyPrice: 30000,
      maxBranches: 1, maxUsers: 10, maxPatientsMonth: 500, maxStorageGb: 5,
      sortOrder: 1,
      isPublic: true,
      features: { opd: true, vaccination: true },
    },
  });
  const mediumPlan = await prisma.subscriptionPlanConfig.create({
    data: {
      code: "MEDIUM",
      name: "Medium",
      description: "Multi-branch operations with full pharmacy + IPD modules.",
      monthlyPrice: 8000,
      yearlyPrice: 80000,
      maxBranches: 3, maxUsers: 30, maxPatientsMonth: 2500, maxStorageGb: 25,
      sortOrder: 2,
      isPublic: true,
      highlightTag: "Most popular",
      features: { opd: true, pharmacy: true, ipd: true, radiology: true, ambulance: true, vaccination: true, hr: true, corporate: true, audit_log: true },
    },
  });
  const enterprisePlan = await prisma.subscriptionPlanConfig.create({
    data: {
      code: "ENTERPRISE",
      name: "Enterprise",
      description: "Large hospitals with white-label branding and priority support.",
      monthlyPrice: 20000,
      yearlyPrice: 200000,
      maxBranches: 99, maxUsers: 200, maxPatientsMonth: 20000, maxStorageGb: 100,
      sortOrder: 3,
      isPublic: true,
      features: { opd: true, pharmacy: true, ipd: true, radiology: true, bloodbank: true, ambulance: true, ot: true, vaccination: true, hr: true, corporate: true, whitelabel: true, audit_log: true },
    },
  });

  // ── Platform tenant (the software owner) ───────────────
  // One Tenant row with isPlatform=true holds the platform admin users. Its
  // SUPER_ADMINs can manage every other tenant (plans, subs, support).
  console.log("  · seeding platform tenant + admin...");
  const platformTenant = await prisma.tenant.create({
    data: {
      name: "DMS Platform",
      slug: "dms-platform",
      isPlatform: true,
      contactEmail: "platform@dms.local",
      contactPhone: "+8801900000000",
    },
  });
  const platformHQ = await prisma.branch.create({
    data: {
      tenantId: platformTenant.id,
      name: "Platform HQ",
      code: "HQ",
    },
  });
  await prisma.user.create({
    data: {
      tenantId: platformTenant.id,
      branchId: platformHQ.id,
      name: "Platform Admin",
      phone: "01900000000",
      email: "owner@dms.local",
      passwordHash: await hash("platform123"),
      role: UserRole.SUPER_ADMIN,
      designation: "Software Owner",
    },
  });

  // ── Tenant ──────────────────────────────────────
  const tenant = await prisma.tenant.create({
    data: {
      name: "Popular Diagnostic Centre",
      slug: "popular",
      contactEmail: "info@populardiagnostic.local",
      contactPhone: "+8801711000000",
      address: "House 16, Road 2, Dhanmondi, Dhaka 1205",
      subscription: {
        create: {
          // Link to the MEDIUM plan via planConfigId so the platform admin
          // sees this tenant on the MEDIUM tier in /platform/tenants. Quotas
          // are also mirrored here so quota enforcement doesn't need a JOIN.
          planConfigId: mediumPlan.id,
          plan: SubscriptionPlan.MEDIUM,
          status: SubscriptionStatus.ACTIVE,
          billingCycle: BillingCycle.MONTHLY,
          monthlyPrice: 8000,
          maxBranches: 3, maxUsers: 30, maxPatientsMonth: 2500, maxStorageGb: 25,
          billingCycleStart: dayjs().startOf("month").toDate(),
          billingCycleEnd: dayjs().endOf("month").toDate(),
          nextBillingDate: dayjs().endOf("month").toDate(),
          paymentMethodNote: [
            "Subscription payment instructions:",
            "  • bKash Merchant: 01711-DMS-PAY (Send Money)",
            "  • Nagad Merchant: 01811-DMS-PAY",
            "  • Bank: City Bank PLC, A/C 1234-5678-9012 (DMS Platform Ltd.)",
            "After paying, share the reference number with your account manager.",
          ].join("\n"),
        },
      },
    },
  });

  // ── Branches ────────────────────────────────────
  const dhanmondi = await prisma.branch.create({
    data: {
      tenantId: tenant.id,
      name: "Dhanmondi Main",
      code: "DHN",
      address: "House 16, Road 2, Dhanmondi, Dhaka 1205",
      phone: "+8809612345678",
      email: "dhanmondi@populardiagnostic.local",
    },
  });
  const uttara = await prisma.branch.create({
    data: {
      tenantId: tenant.id,
      name: "Uttara Branch",
      code: "UTT",
      address: "House 5, Sector 7, Uttara, Dhaka",
      phone: "+8809612345679",
    },
  });

  // ── Users ───────────────────────────────────────
  const admin = await prisma.user.create({
    data: {
      tenantId: tenant.id, branchId: dhanmondi.id,
      name: "Admin User", phone: "01700000000", email: "admin@dms.local",
      passwordHash: await hash("admin123"),
      role: UserRole.SUPER_ADMIN, designation: "System Administrator",
    },
  });

  const recep = await prisma.user.create({
    data: {
      tenantId: tenant.id, branchId: dhanmondi.id,
      name: "Mahbuba Akter", phone: "01700000001",
      passwordHash: await hash("recep123"),
      role: UserRole.RECEPTIONIST, designation: "Senior Receptionist",
    },
  });

  const labTech = await prisma.user.create({
    data: {
      tenantId: tenant.id, branchId: dhanmondi.id,
      name: "Rakib Hasan", phone: "01700000002",
      passwordHash: await hash("lab123"),
      role: UserRole.LAB_TECHNICIAN, designation: "Senior Lab Technician",
    },
  });

  const doctor = await prisma.user.create({
    data: {
      tenantId: tenant.id, branchId: dhanmondi.id,
      name: "Dr. Salma Khatun", phone: "01700000003",
      passwordHash: await hash("doctor123"),
      role: UserRole.DOCTOR, designation: "Consultant Pathologist",
      bmdcNumber: "A-12345", qualifications: "MBBS, FCPS (Pathology)",
      specialization: "Clinical Pathology", consultationFee: 1500,
    },
  });

  const accountant = await prisma.user.create({
    data: {
      tenantId: tenant.id, branchId: dhanmondi.id,
      name: "Tania Sultana", phone: "01700000004",
      passwordHash: await hash("acct123"),
      role: UserRole.ACCOUNTANT, designation: "Chief Accountant",
    },
  });

  const nurse = await prisma.user.create({
    data: {
      tenantId: tenant.id, branchId: dhanmondi.id,
      name: "Shabana Begum", phone: "01700000005",
      passwordHash: await hash("nurse123"),
      role: UserRole.NURSE, designation: "Senior Staff Nurse",
    },
  });

  const pharmacist = await prisma.user.create({
    data: {
      tenantId: tenant.id, branchId: dhanmondi.id,
      name: "Iqbal Hossain", phone: "01700000006",
      passwordHash: await hash("pharma123"),
      role: UserRole.PHARMACIST, designation: "Chief Pharmacist",
    },
  });

  const hrMgr = await prisma.user.create({
    data: {
      tenantId: tenant.id, branchId: dhanmondi.id,
      name: "Farzana Yasmin", phone: "01700000007",
      passwordHash: await hash("hr123"),
      role: UserRole.HR_MANAGER, designation: "HR Manager",
    },
  });

  const surgeon = await prisma.user.create({
    data: {
      tenantId: tenant.id, branchId: dhanmondi.id,
      name: "Dr. Aminul Islam", phone: "01700000008",
      passwordHash: await hash("doctor123"),
      role: UserRole.DOCTOR, designation: "Consultant Surgeon",
      bmdcNumber: "A-22221", qualifications: "MBBS, FCPS (Surgery), FRCS (Edin)",
      specialization: "General & Laparoscopic Surgery", consultationFee: 2000,
    },
  });

  const cardiologist = await prisma.user.create({
    data: {
      tenantId: tenant.id, branchId: dhanmondi.id,
      name: "Dr. Reza Karim", phone: "01700000009",
      passwordHash: await hash("doctor123"),
      role: UserRole.DOCTOR, designation: "Consultant Cardiologist",
      bmdcNumber: "A-22333", qualifications: "MBBS, MD (Cardiology)",
      specialization: "Cardiology", consultationFee: 2500,
    },
  });

  const gyne = await prisma.user.create({
    data: {
      tenantId: tenant.id, branchId: uttara.id,
      name: "Dr. Nasrin Ahmed", phone: "01700000010",
      passwordHash: await hash("doctor123"),
      role: UserRole.DOCTOR, designation: "Consultant Gynaecologist",
      bmdcNumber: "A-22444", qualifications: "MBBS, FCPS (Gynae)",
      specialization: "Gynaecology & Obstetrics", consultationFee: 1800,
    },
  });

  const allStaff = [admin, recep, labTech, doctor, accountant, nurse, pharmacist, hrMgr, surgeon, cardiologist, gyne];

  // ── Test categories ─────────────────────────────
  const catBlood = await prisma.testCategory.create({
    data: { tenantId: tenant.id, nameEn: "Hematology", nameBn: "রক্ত পরীক্ষা", icon: "blood", sortOrder: 1 },
  });
  const catBiochem = await prisma.testCategory.create({
    data: { tenantId: tenant.id, nameEn: "Biochemistry", nameBn: "বায়োকেমিস্ট্রি", icon: "flask", sortOrder: 2 },
  });
  const catUrine = await prisma.testCategory.create({
    data: { tenantId: tenant.id, nameEn: "Urinalysis", nameBn: "প্রস্রাব পরীক্ষা", icon: "drop", sortOrder: 3 },
  });
  const catImaging = await prisma.testCategory.create({
    data: { tenantId: tenant.id, nameEn: "Imaging", nameBn: "ইমেজিং", icon: "scan", sortOrder: 4 },
  });
  const catCardiac = await prisma.testCategory.create({
    data: { tenantId: tenant.id, nameEn: "Cardiac", nameBn: "হৃদরোগ", icon: "heart", sortOrder: 5 },
  });

  // ── Tests ───────────────────────────────────────
  const cbc = await prisma.test.create({
    data: {
      tenantId: tenant.id, categoryId: catBlood.id,
      code: "CBC", nameEn: "Complete Blood Count (CBC)", nameBn: "সম্পূর্ণ রক্ত গণনা",
      sampleType: "Whole Blood (EDTA)", basePrice: 400, turnaroundHours: 4,
      instructions: "No fasting required.",
      resultSchema: [
        { field: "Hemoglobin", unit: "g/dL", refRange: "13.0 – 17.0 (M) / 12.0 – 15.0 (F)" },
        { field: "RBC Count", unit: "10⁶/μL", refRange: "4.5 – 5.5" },
        { field: "WBC Count", unit: "10³/μL", refRange: "4.0 – 11.0" },
        { field: "Platelet Count", unit: "10³/μL", refRange: "150 – 450" },
        { field: "Hematocrit (PCV)", unit: "%", refRange: "40 – 50" },
        { field: "MCV", unit: "fL", refRange: "80 – 100" },
      ],
    },
  });

  const lft = await prisma.test.create({
    data: {
      tenantId: tenant.id, categoryId: catBiochem.id,
      code: "LFT", nameEn: "Liver Function Test (LFT)", nameBn: "লিভার ফাংশন টেস্ট",
      sampleType: "Serum", basePrice: 1200, turnaroundHours: 6,
      instructions: "8-hour fasting required.",
      resultSchema: [
        { field: "ALT (SGPT)", unit: "U/L", refRange: "5 – 40" },
        { field: "AST (SGOT)", unit: "U/L", refRange: "5 – 40" },
        { field: "ALP", unit: "U/L", refRange: "44 – 147" },
        { field: "Total Bilirubin", unit: "mg/dL", refRange: "0.1 – 1.2" },
        { field: "Albumin", unit: "g/dL", refRange: "3.5 – 5.0" },
      ],
    },
  });

  const fbs = await prisma.test.create({
    data: {
      tenantId: tenant.id, categoryId: catBiochem.id,
      code: "FBS", nameEn: "Fasting Blood Sugar", nameBn: "খালি পেটে রক্তের চিনি",
      sampleType: "Serum/Plasma", basePrice: 200, turnaroundHours: 2,
      instructions: "8-12 hours of fasting required.",
      resultSchema: [
        { field: "Glucose (Fasting)", unit: "mg/dL", refRange: "70 – 110" },
      ],
    },
  });

  await prisma.test.create({
    data: {
      tenantId: tenant.id, categoryId: catBiochem.id,
      code: "HBA1C", nameEn: "HbA1c (Glycated Hemoglobin)", nameBn: "এইচবিএ১সি",
      sampleType: "Whole Blood (EDTA)", basePrice: 800, turnaroundHours: 6,
      resultSchema: [{ field: "HbA1c", unit: "%", refRange: "< 5.7 normal / 5.7 – 6.4 prediabetes / ≥ 6.5 diabetes" }],
    },
  });

  await prisma.test.create({
    data: {
      tenantId: tenant.id, categoryId: catUrine.id,
      code: "URE-RE", nameEn: "Urine Routine Examination", nameBn: "প্রস্রাব রুটিন",
      sampleType: "Random Urine", basePrice: 250, turnaroundHours: 3,
    },
  });

  await prisma.test.create({
    data: {
      tenantId: tenant.id, categoryId: catImaging.id,
      code: "XR-CHEST", nameEn: "Chest X-Ray (PA View)", nameBn: "বুকের এক্স-রে",
      sampleType: "—", basePrice: 600, turnaroundHours: 2,
    },
  });

  await prisma.test.create({
    data: {
      tenantId: tenant.id, categoryId: catImaging.id,
      code: "USG-WA", nameEn: "Ultrasonogram - Whole Abdomen", nameBn: "পেটের আলট্রাসনোগ্রাম",
      sampleType: "—", basePrice: 1500, turnaroundHours: 2,
      instructions: "Full bladder required. Empty stomach for upper abdomen.",
    },
  });

  await prisma.test.create({
    data: {
      tenantId: tenant.id, categoryId: catCardiac.id,
      code: "ECG", nameEn: "Electrocardiogram (ECG)", nameBn: "ইসিজি",
      sampleType: "—", basePrice: 500, turnaroundHours: 1,
    },
  });

  // ── Referrers ───────────────────────────────────
  const refDr1 = await prisma.referrer.create({
    data: {
      tenantId: tenant.id, name: "Dr. Imran Khan", phone: "01711333444",
      designation: "Consultant Physician", hospital: "Sir Salimullah Medical College",
      bmdcNumber: "A-11111", defaultCommissionPercent: 10,
    },
  });
  await prisma.referrer.create({
    data: {
      tenantId: tenant.id, name: "Dr. Sabrina Ferdous", phone: "01711555666",
      designation: "Pediatrician", hospital: "Dhaka Shishu Hospital",
      bmdcNumber: "A-22222", defaultCommissionPercent: 12,
    },
  });

  // ── Patients ────────────────────────────────────
  const today = dayjs().format("YYYYMMDD");
  const patientsData = [
    { name: "Md. Rahim Uddin", phone: "01911111111", dob: "1985-04-12", gender: Gender.MALE, address: "Dhanmondi, Dhaka", bloodGroup: "B+" },
    { name: "Fatema Begum", phone: "01911111112", dob: "1992-08-03", gender: Gender.FEMALE, address: "Mirpur, Dhaka", bloodGroup: "A+" },
    { name: "Karim Sheikh", phone: "01911111113", dob: "1978-12-22", gender: Gender.MALE, address: "Uttara, Dhaka", bloodGroup: "O+" },
    { name: "Nasrin Akter", phone: "01911111114", dob: "1995-06-18", gender: Gender.FEMALE, address: "Mohammadpur, Dhaka", bloodGroup: "AB+" },
    { name: "Hasan Mahmud", phone: "01911111115", dob: "1980-01-30", gender: Gender.MALE, address: "Banani, Dhaka", bloodGroup: "B-" },
    { name: "Sumi Rahman", phone: "01911111116", dob: "1998-03-25", gender: Gender.FEMALE, address: "Gulshan, Dhaka", bloodGroup: "O-" },
    { name: "Saiful Alam", phone: "01911111117", dob: "1965-11-08", gender: Gender.MALE, address: "Mohakhali, Dhaka", bloodGroup: "A-" },
    { name: "Roksana Khatun", phone: "01911111118", dob: "1972-07-15", gender: Gender.FEMALE, address: "Old Dhaka", bloodGroup: "B+" },
    { name: "Sajid Hossain", phone: "01911111119", dob: "2010-09-04", gender: Gender.MALE, address: "Bashundhara, Dhaka", bloodGroup: "O+" },
    { name: "Anika Tabassum", phone: "01911111120", dob: "2018-02-14", gender: Gender.FEMALE, address: "Mohammadpur, Dhaka", bloodGroup: "A+" },
  ];

  const patients: Awaited<ReturnType<typeof prisma.patient.create>>[] = [];
  for (let i = 0; i < patientsData.length; i++) {
    const p = patientsData[i];
    patients.push(
      await prisma.patient.create({
        data: {
          tenantId: tenant.id, branchId: dhanmondi.id,
          patientCode: `PAT-${today}-${String(i + 1).padStart(4, "0")}`,
          name: p.name, phone: p.phone, dob: new Date(p.dob),
          gender: p.gender, address: p.address, bloodGroup: p.bloodGroup,
        },
      })
    );
  }

  // ── Orders + Invoices + Reports ─────────────────
  const inv1 = await prisma.invoice.create({
    data: {
      tenantId: tenant.id, branchId: dhanmondi.id, patientId: patients[0].id,
      invoiceNumber: `INV-${dayjs().format("YYMMDD")}-00001`,
      subtotal: 600, vatAmount: 0, totalAmount: 600,
      paidAmount: 600, dueAmount: 0, status: "PAID",
    },
  });
  const order1 = await prisma.testOrder.create({
    data: {
      tenantId: tenant.id, branchId: dhanmondi.id, patientId: patients[0].id,
      orderedById: admin.id, referrerId: refDr1.id,
      orderNumber: `ORD-${dayjs().format("YYMMDD")}-00001`,
      status: "COMPLETED", invoiceId: inv1.id,
      items: {
        create: [
          { testId: cbc.id, price: 400, barcode: barcode(1), status: "COMPLETED", sampleCollectedAt: new Date() },
          { testId: fbs.id, price: 200, barcode: barcode(2), status: "COMPLETED", sampleCollectedAt: new Date() },
        ],
      },
    },
    include: { items: true },
  });
  await prisma.payment.create({
    data: {
      tenantId: tenant.id, invoiceId: inv1.id, amount: 600,
      method: PaymentMethod.BKASH, referenceNo: "BKS123456789",
      collectedById: admin.id,
    },
  });

  await prisma.report.create({
    data: {
      tenantId: tenant.id, orderId: order1.id, orderItemId: order1.items[0].id,
      technicianId: labTech.id, doctorId: doctor.id, status: "APPROVED",
      submittedAt: dayjs().subtract(2, "hour").toDate(),
      approvedAt: dayjs().subtract(1, "hour").toDate(),
      qrToken: qrToken(),
      conclusion: "All parameters within normal range. No further action required.",
      resultData: {
        "Hemoglobin": { value: "14.5", unit: "g/dL", refRange: "13.0 – 17.0", flag: "N" },
        "RBC Count": { value: "5.1", unit: "10⁶/μL", refRange: "4.5 – 5.5", flag: "N" },
        "WBC Count": { value: "7.8", unit: "10³/μL", refRange: "4.0 – 11.0", flag: "N" },
        "Platelet Count": { value: "240", unit: "10³/μL", refRange: "150 – 450", flag: "N" },
        "Hematocrit (PCV)": { value: "43", unit: "%", refRange: "40 – 50", flag: "N" },
        "MCV": { value: "88", unit: "fL", refRange: "80 – 100", flag: "N" },
      },
    },
  });
  await prisma.report.create({
    data: {
      tenantId: tenant.id, orderId: order1.id, orderItemId: order1.items[1].id,
      technicianId: labTech.id, status: "PENDING_APPROVAL",
      submittedAt: dayjs().subtract(30, "minute").toDate(),
      qrToken: qrToken(), isAbnormal: true,
      resultData: {
        "Glucose (Fasting)": { value: "138", unit: "mg/dL", refRange: "70 – 110", flag: "H" },
      },
      conclusion: "Fasting glucose elevated. Recommend HbA1c follow-up.",
    },
  });

  const inv2 = await prisma.invoice.create({
    data: {
      tenantId: tenant.id, branchId: dhanmondi.id, patientId: patients[1].id,
      invoiceNumber: `INV-${dayjs().format("YYMMDD")}-00002`,
      subtotal: 1200, totalAmount: 1200, paidAmount: 500, dueAmount: 700,
      status: "PARTIALLY_PAID",
    },
  });
  const order2 = await prisma.testOrder.create({
    data: {
      tenantId: tenant.id, branchId: dhanmondi.id, patientId: patients[1].id,
      orderedById: admin.id,
      orderNumber: `ORD-${dayjs().format("YYMMDD")}-00002`,
      status: "PROCESSING", invoiceId: inv2.id,
      items: {
        create: [
          { testId: lft.id, price: 1200, barcode: barcode(3), status: "IN_LAB", sampleCollectedAt: new Date() },
        ],
      },
    },
    include: { items: true },
  });
  await prisma.payment.create({
    data: { tenantId: tenant.id, invoiceId: inv2.id, amount: 500, method: PaymentMethod.CASH, collectedById: accountant.id },
  });
  await prisma.report.create({
    data: { tenantId: tenant.id, orderId: order2.id, orderItemId: order2.items[0].id, status: "DRAFT", qrToken: qrToken() },
  });

  const inv3 = await prisma.invoice.create({
    data: {
      tenantId: tenant.id, branchId: uttara.id, patientId: patients[2].id,
      invoiceNumber: `INV-${dayjs().format("YYMMDD")}-00003`,
      subtotal: 400, totalAmount: 400, paidAmount: 0, dueAmount: 400, status: "ISSUED",
    },
  });
  await prisma.testOrder.create({
    data: {
      tenantId: tenant.id, branchId: uttara.id, patientId: patients[2].id,
      orderedById: admin.id,
      orderNumber: `ORD-${dayjs().format("YYMMDD")}-00003`,
      status: "PENDING", invoiceId: inv3.id,
      items: {
        create: [{ testId: cbc.id, price: 400, barcode: barcode(4), status: "PENDING" }],
      },
    },
  });

  // ── ICD-10 lookup ───────────────────────────────
  await prisma.icdCode.createMany({
    data: [
      { code: "A09", term: "Diarrhoea and gastroenteritis of presumed infectious origin", category: "Infectious" },
      { code: "B19.9", term: "Unspecified viral hepatitis without hepatic coma", category: "Infectious" },
      { code: "E10.9", term: "Type 1 diabetes mellitus without complications", category: "Endocrine" },
      { code: "E11.9", term: "Type 2 diabetes mellitus without complications", category: "Endocrine" },
      { code: "E78.5", term: "Hyperlipidaemia, unspecified", category: "Endocrine" },
      { code: "E66.9", term: "Obesity, unspecified", category: "Endocrine" },
      { code: "E03.9", term: "Hypothyroidism, unspecified", category: "Endocrine" },
      { code: "E05.9", term: "Thyrotoxicosis, unspecified", category: "Endocrine" },
      { code: "F32.9", term: "Major depressive disorder, single episode, unspecified", category: "Mental" },
      { code: "F41.9", term: "Anxiety disorder, unspecified", category: "Mental" },
      { code: "F51.0", term: "Insomnia not due to a substance or known physiological condition", category: "Mental" },
      { code: "G43.9", term: "Migraine, unspecified", category: "Neurological" },
      { code: "G44.2", term: "Tension-type headache", category: "Neurological" },
      { code: "G47.00", term: "Insomnia, unspecified", category: "Neurological" },
      { code: "H10.9", term: "Unspecified conjunctivitis", category: "Eye" },
      { code: "H66.9", term: "Otitis media, unspecified", category: "Ear" },
      { code: "I10", term: "Essential (primary) hypertension", category: "Circulatory" },
      { code: "I25.10", term: "Atherosclerotic heart disease of native coronary artery", category: "Circulatory" },
      { code: "I50.9", term: "Heart failure, unspecified", category: "Circulatory" },
      { code: "J00", term: "Acute nasopharyngitis (common cold)", category: "Respiratory" },
      { code: "J02.9", term: "Acute pharyngitis, unspecified", category: "Respiratory" },
      { code: "J06.9", term: "Acute upper respiratory infection, unspecified", category: "Respiratory" },
      { code: "J18.9", term: "Pneumonia, unspecified organism", category: "Respiratory" },
      { code: "J20.9", term: "Acute bronchitis, unspecified", category: "Respiratory" },
      { code: "J30.9", term: "Allergic rhinitis, unspecified", category: "Respiratory" },
      { code: "J44.9", term: "Chronic obstructive pulmonary disease, unspecified", category: "Respiratory" },
      { code: "J45.909", term: "Unspecified asthma, uncomplicated", category: "Respiratory" },
      { code: "K21.9", term: "Gastro-oesophageal reflux disease without oesophagitis", category: "Digestive" },
      { code: "K25.9", term: "Gastric ulcer, unspecified", category: "Digestive" },
      { code: "K29.7", term: "Gastritis, unspecified", category: "Digestive" },
      { code: "K30", term: "Functional dyspepsia", category: "Digestive" },
      { code: "K59.00", term: "Constipation, unspecified", category: "Digestive" },
      { code: "K80.20", term: "Calculus of gallbladder without cholecystitis", category: "Digestive" },
      { code: "L20.9", term: "Atopic dermatitis, unspecified", category: "Skin" },
      { code: "L23.9", term: "Allergic contact dermatitis, unspecified cause", category: "Skin" },
      { code: "L30.9", term: "Dermatitis, unspecified", category: "Skin" },
      { code: "L50.9", term: "Urticaria, unspecified", category: "Skin" },
      { code: "M25.50", term: "Pain in unspecified joint", category: "Musculoskeletal" },
      { code: "M54.5", term: "Low back pain", category: "Musculoskeletal" },
      { code: "M79.1", term: "Myalgia", category: "Musculoskeletal" },
      { code: "M81.0", term: "Age-related osteoporosis without current pathological fracture", category: "Musculoskeletal" },
      { code: "N39.0", term: "Urinary tract infection, site not specified", category: "Genitourinary" },
      { code: "N18.9", term: "Chronic kidney disease, unspecified", category: "Genitourinary" },
      { code: "O80", term: "Single spontaneous delivery", category: "Pregnancy" },
      { code: "R05", term: "Cough", category: "Symptoms" },
      { code: "R10.4", term: "Other and unspecified abdominal pain", category: "Symptoms" },
      { code: "R11", term: "Nausea and vomiting", category: "Symptoms" },
      { code: "R50.9", term: "Fever, unspecified", category: "Symptoms" },
      { code: "R51", term: "Headache", category: "Symptoms" },
      { code: "R53.83", term: "Other fatigue", category: "Symptoms" },
      { code: "Z00.00", term: "General adult medical examination without abnormal findings", category: "Wellness" },
    ],
  });

  // ── Pharmacy: supplier + medicines + opening batches ──
  const supplier = await prisma.supplier.create({
    data: {
      tenantId: tenant.id, name: "Square Distributors Ltd.",
      contactPerson: "Md. Karim", phone: "+8801711222333",
      email: "orders@squaredist.local", address: "Mohakhali C/A, Dhaka",
      vatRegNo: "BIN-12345678",
    },
  });
  const supplier2 = await prisma.supplier.create({
    data: {
      tenantId: tenant.id, name: "Beximco Pharma Distribution",
      contactPerson: "Tareq Ahmed", phone: "+8801711222444",
      address: "Tongi, Gazipur", vatRegNo: "BIN-87654321",
    },
  });

  const medicineSeed = [
    { brand: "Napa 500", generic: "Paracetamol", strength: "500 mg", form: "Tablet", mfr: "Beximco", price: 2.5 },
    { brand: "Napa Extra", generic: "Paracetamol + Caffeine", strength: "500+65 mg", form: "Tablet", mfr: "Beximco", price: 3.0 },
    { brand: "Sergel 20", generic: "Esomeprazole", strength: "20 mg", form: "Capsule", mfr: "Healthcare", price: 7.0 },
    { brand: "Maxpro 20", generic: "Esomeprazole", strength: "20 mg", form: "Capsule", mfr: "Renata", price: 7.0 },
    { brand: "Filmet 400", generic: "Metronidazole", strength: "400 mg", form: "Tablet", mfr: "Beximco", price: 2.0 },
    { brand: "Azithro 500", generic: "Azithromycin", strength: "500 mg", form: "Tablet", mfr: "Square", price: 35.0 },
    { brand: "Cef-3 200", generic: "Cefixime", strength: "200 mg", form: "Capsule", mfr: "Drug International", price: 22.0 },
    { brand: "Tufnil 200", generic: "Tolfenamic Acid", strength: "200 mg", form: "Tablet", mfr: "ACI", price: 12.0 },
    { brand: "Histacin", generic: "Chlorpheniramine Maleate", strength: "4 mg", form: "Tablet", mfr: "Opsonin", price: 0.8 },
    { brand: "Salbutamol 4mg", generic: "Salbutamol", strength: "4 mg", form: "Tablet", mfr: "Square", price: 1.5 },
    { brand: "Bekaslin Spray", generic: "Salbutamol", strength: "100 mcg/dose", form: "Inhaler", mfr: "Beximco", price: 280.0 },
    { brand: "Losectil 20", generic: "Omeprazole", strength: "20 mg", form: "Capsule", mfr: "Eskayef", price: 6.0 },
    { brand: "Amodis 400", generic: "Metronidazole", strength: "400 mg", form: "Tablet", mfr: "Square", price: 2.0 },
    { brand: "Cinaron 25", generic: "Cinnarizine", strength: "25 mg", form: "Tablet", mfr: "Square", price: 1.5 },
    { brand: "Atenolol 50", generic: "Atenolol", strength: "50 mg", form: "Tablet", mfr: "Beximco", price: 2.0 },
    { brand: "Amdocal 5", generic: "Amlodipine", strength: "5 mg", form: "Tablet", mfr: "Square", price: 2.5 },
    { brand: "Metform 500", generic: "Metformin", strength: "500 mg", form: "Tablet", mfr: "Square", price: 1.5 },
    { brand: "Comet 500", generic: "Metformin", strength: "500 mg", form: "Tablet", mfr: "Eskayef", price: 1.5 },
    { brand: "Rosuva 10", generic: "Rosuvastatin", strength: "10 mg", form: "Tablet", mfr: "Beximco", price: 12.0 },
    { brand: "Ecosprin 75", generic: "Aspirin", strength: "75 mg", form: "Tablet", mfr: "Square", price: 0.5 },
    { brand: "Maxima Syrup", generic: "Paracetamol", strength: "120 mg/5 ml", form: "Syrup 60ml", mfr: "ACI", price: 35.0 },
    { brand: "Aristopharma ORS", generic: "ORS", strength: "21 g sachet", form: "Powder", mfr: "Aristopharma", price: 12.0 },
    { brand: "Vita-B Complex", generic: "Vitamin B-Complex", strength: "—", form: "Tablet", mfr: "Renata", price: 1.5 },
    { brand: "Calbo-D", generic: "Calcium + Vit D", strength: "500+200 IU", form: "Tablet", mfr: "Square", price: 4.0 },
    { brand: "Insulin Mixtard 30", generic: "Insulin (biphasic)", strength: "100 IU/ml", form: "Vial 10 ml", mfr: "Novo Nordisk", price: 540.0 },
  ];

  const medicineRecords: { id: string; price: number; brand: string }[] = [];
  for (const m of medicineSeed) {
    const rec = await prisma.medicine.create({
      data: {
        tenantId: tenant.id,
        brandName: m.brand, genericName: m.generic, strength: m.strength,
        form: m.form, manufacturer: m.mfr,
        salePrice: m.price, reorderLevel: 30, taxRate: 0,
        unitsPerBox: m.form.startsWith("Tablet") || m.form.startsWith("Capsule") ? 10 : 1,
        boxPrice: (m.form.startsWith("Tablet") || m.form.startsWith("Capsule")) ? m.price * 10 * 0.95 : null,
      },
    });
    medicineRecords.push({ id: rec.id, price: m.price, brand: m.brand });
  }

  // Opening stock for the first 10 medicines at Dhanmondi.
  const batches: { id: string; medicineId: string; price: number; brand: string }[] = [];
  for (let i = 0; i < 10; i++) {
    const m = medicineRecords[i];
    const opening = 500;
    const expiry = dayjs().add(18, "month").toDate();
    const batch = await prisma.medicineBatch.create({
      data: {
        tenantId: tenant.id, medicineId: m.id, branchId: dhanmondi.id,
        supplierId: i % 2 === 0 ? supplier.id : supplier2.id,
        batchNumber: `B${dayjs().format("YYMM")}${String(i + 1).padStart(3, "0")}`,
        expiryDate: expiry, mrp: m.price, purchasePrice: m.price * 0.7,
        qtyReceived: opening, qtyOnHand: opening,
      },
    });
    await prisma.stockMovement.create({
      data: {
        tenantId: tenant.id, batchId: batch.id, delta: opening, reason: "PURCHASE",
        refTable: "medicine_batches", refId: batch.id, createdById: admin.id,
      },
    });
    batches.push({ id: batch.id, medicineId: m.id, price: m.price, brand: m.brand });
  }

  // A pharmacy sale (walk-in)
  const saleNo = `PHS-${dayjs().format("YYMMDD")}-0001`;
  const napa = batches[0];
  const sergel = batches[2];
  const saleAmount = 25 * 1 + 6 * napa.price + 4 * sergel.price;
  const saleInv = await prisma.invoice.create({
    data: {
      tenantId: tenant.id, branchId: dhanmondi.id, patientId: patients[0].id,
      invoiceNumber: `INV-${dayjs().format("YYMMDD")}-00010`,
      kind: "PHARMACY", subtotal: saleAmount, totalAmount: saleAmount,
      paidAmount: saleAmount, dueAmount: 0, status: "PAID",
    },
  });
  await prisma.pharmacySale.create({
    data: {
      tenantId: tenant.id, branchId: dhanmondi.id, patientId: patients[0].id,
      saleNumber: saleNo, soldById: pharmacist.id, status: "COMPLETED",
      invoiceId: saleInv.id,
      items: {
        create: [
          { medicineId: napa.medicineId, batchId: napa.id, qty: 6, unit: "PIECE", unitsPerBox: 10, unitPrice: napa.price, amount: napa.price * 6 },
          { medicineId: sergel.medicineId, batchId: sergel.id, qty: 4, unit: "PIECE", unitsPerBox: 10, unitPrice: sergel.price, amount: sergel.price * 4 },
        ],
      },
    },
  });
  await prisma.medicineBatch.update({ where: { id: napa.id }, data: { qtyOnHand: { decrement: 6 } } });
  await prisma.medicineBatch.update({ where: { id: sergel.id }, data: { qtyOnHand: { decrement: 4 } } });
  await prisma.stockMovement.createMany({
    data: [
      { tenantId: tenant.id, batchId: napa.id, delta: -6, reason: "SALE", refTable: "pharmacy_sales", refId: saleInv.id, createdById: pharmacist.id },
      { tenantId: tenant.id, batchId: sergel.id, delta: -4, reason: "SALE", refTable: "pharmacy_sales", refId: saleInv.id, createdById: pharmacist.id },
    ],
  });
  await prisma.payment.create({
    data: { tenantId: tenant.id, invoiceId: saleInv.id, amount: saleAmount, method: PaymentMethod.CASH, collectedById: pharmacist.id },
  });

  // ── Doctor schedules ──
  for (const day of [0, 1, 3]) {
    await prisma.doctorSchedule.create({
      data: { tenantId: tenant.id, doctorId: doctor.id, branchId: dhanmondi.id, dayOfWeek: day, startTime: "17:00", endTime: "21:00", slotMinutes: 20, consultationFee: 1200 },
    });
  }
  for (const day of [1, 2, 4]) {
    await prisma.doctorSchedule.create({
      data: { tenantId: tenant.id, doctorId: cardiologist.id, branchId: dhanmondi.id, dayOfWeek: day, startTime: "18:00", endTime: "22:00", slotMinutes: 30, consultationFee: 2500 },
    });
  }
  for (const day of [0, 2, 4]) {
    await prisma.doctorSchedule.create({
      data: { tenantId: tenant.id, doctorId: gyne.id, branchId: uttara.id, dayOfWeek: day, startTime: "16:00", endTime: "20:00", slotMinutes: 30, consultationFee: 1800 },
    });
  }

  // ── Appointments + Consultation (one done with prescription) ──
  const aptTomorrow = dayjs().add(1, "day").hour(17).minute(0).second(0).millisecond(0);
  const apt1 = await prisma.appointment.create({
    data: {
      tenantId: tenant.id, branchId: dhanmondi.id, patientId: patients[0].id, doctorId: doctor.id,
      slotStart: aptTomorrow.toDate(), slotEnd: aptTomorrow.add(20, "minute").toDate(),
      tokenNumber: 1, status: AppointmentStatus.BOOKED, visitType: VisitType.NEW,
      bookedById: recep.id, reason: "Persistent cough x 1 week",
    },
  });
  const apt2 = await prisma.appointment.create({
    data: {
      tenantId: tenant.id, branchId: dhanmondi.id, patientId: patients[4].id, doctorId: cardiologist.id,
      slotStart: dayjs().subtract(2, "day").hour(18).minute(30).toDate(),
      slotEnd: dayjs().subtract(2, "day").hour(19).minute(0).toDate(),
      tokenNumber: 5, status: AppointmentStatus.COMPLETED, visitType: VisitType.FOLLOW_UP,
      bookedById: recep.id, reason: "Hypertension follow-up",
    },
  });
  // A finished consultation with diagnosis & prescription
  const consult1 = await prisma.consultation.create({
    data: {
      tenantId: tenant.id, appointmentId: apt2.id, patientId: patients[4].id, doctorId: cardiologist.id,
      chiefComplaint: "Patient reports occasional chest tightness and headaches.",
      historyOfPresentIllness: "BP control suboptimal on Amlodipine 5 mg. No syncope or palpitations.",
      examination: "BP 150/95, Pulse 78/min regular, JVP not raised. Heart sounds S1+S2 normal.",
      vitals: { bp: "150/95", pulse: 78, temp: "98.4F", spo2: 98, weight: 78 },
      notes: "Step up antihypertensive. Lifestyle counselling done.",
      followUpDate: dayjs().add(30, "day").toDate(),
      completedAt: dayjs().subtract(2, "day").toDate(),
    },
  });
  await prisma.diagnosis.create({
    data: { consultationId: consult1.id, icdCode: "I10", icdTerm: "Essential (primary) hypertension" },
  });
  await prisma.prescription.create({
    data: {
      tenantId: tenant.id, consultationId: consult1.id,
      advice: "Salt restriction. Daily 30-min brisk walk. Recheck BP in 2 weeks.",
      items: {
        create: [
          { medicineId: medicineRecords.find((m) => m.brand === "Amdocal 5")?.id ?? null, medicineName: "Amdocal 5", dosage: "5 mg", frequency: "1+0+0", durationDays: 30, instructions: "Morning, after breakfast", sortOrder: 1 },
          { medicineId: medicineRecords.find((m) => m.brand === "Ecosprin 75")?.id ?? null, medicineName: "Ecosprin 75", dosage: "75 mg", frequency: "0+1+0", durationDays: 30, instructions: "After lunch", sortOrder: 2 },
          { medicineName: "Olmesartan 20 mg", dosage: "20 mg", frequency: "1+0+0", durationDays: 30, instructions: "Morning", sortOrder: 3 },
        ],
      },
    },
  });

  // ── Notices ─────────────────────────────────────
  const notice1 = await prisma.notice.create({
    data: {
      tenantId: tenant.id, postedById: admin.id,
      title: "Eid holiday schedule",
      body: "Lab service will be limited from 10–13 April for Eid-ul-Fitr. Emergency lab and pharmacy will remain open 24/7. Please coordinate weekend on-call with HR.",
      audience: NoticeAudience.ALL_STAFF, pinned: true,
    },
  });
  await prisma.notice.create({
    data: {
      tenantId: tenant.id, postedById: hrMgr.id,
      title: "Payroll cut-off reminder",
      body: "Please submit all overtime and attendance corrections by the 28th of each month. Late submissions will be processed next cycle.",
      audience: NoticeAudience.ALL_STAFF, pinned: false,
    },
  });
  await prisma.notice.create({
    data: {
      tenantId: tenant.id, postedById: admin.id,
      title: "New blood bank cold-chain SOP",
      body: "Updated SOP for blood bag receipt — all bags must enter QUARANTINE status; release to AVAILABLE only after all 5 screening tests are NEGATIVE.",
      audience: NoticeAudience.NURSES,
    },
  });
  await prisma.noticeReceipt.create({ data: { noticeId: notice1.id, userId: recep.id } });

  // ── SMS templates ───────────────────────────────
  const smsTemplates = [
    { code: "WELCOME_PATIENT", name: "Welcome new patient", body: "Hello {{name}}, welcome to {{clinic}}! Your patient ID is {{patientCode}}. Save this number to view reports online." },
    { code: "APPT_CONFIRMED", name: "Appointment confirmed", body: "Dear {{name}}, your appointment with {{doctor}} on {{slot}} is confirmed. Token: {{token}}. Please arrive 15 min early." },
    { code: "APPT_REMINDER", name: "Appointment reminder", body: "Reminder: {{name}}, your appointment with {{doctor}} is tomorrow {{slot}}. Token: {{token}}. — {{clinic}}" },
    { code: "REPORT_READY", name: "Report ready", body: "Hello {{name}}, your {{test}} report is ready. View at {{url}} or collect from {{branch}}. — {{clinic}}" },
    { code: "INVOICE_DUE", name: "Invoice due reminder", body: "Dear {{name}}, invoice {{invoiceNo}} of BDT {{amount}} is pending. Pay via bKash/Nagad/Cash at counter. — {{clinic}}" },
    { code: "OTP_LOGIN", name: "Patient login OTP", body: "Your {{clinic}} login OTP is {{otp}}. Valid for 5 minutes. Do not share." },
  ];
  for (const t of smsTemplates) {
    await prisma.smsTemplate.create({ data: { tenantId: tenant.id, ...t } });
  }

  // ── Health cards ────────────────────────────────
  const cardSilver = await prisma.healthCard.create({
    data: { tenantId: tenant.id, name: "Silver", description: "5% discount on diagnostics + 1 free CBC/year", discountPercent: 5, monthlyFee: 200, validityDays: 365 },
  });
  await prisma.healthCard.create({
    data: { tenantId: tenant.id, name: "Gold", description: "10% discount on all services + free annual checkup", discountPercent: 10, monthlyFee: 500, validityDays: 365 },
  });
  await prisma.healthCard.create({
    data: { tenantId: tenant.id, name: "Platinum", description: "20% discount on all services + 2 free specialist visits/year", discountPercent: 20, monthlyFee: 1000, validityDays: 365 },
  });
  await prisma.patientHealthCard.create({
    data: {
      tenantId: tenant.id, patientId: patients[0].id, cardId: cardSilver.id,
      cardNumber: `HC-${dayjs().format("YY")}-00001`,
      issuedAt: dayjs().subtract(2, "month").toDate(),
      expiresAt: dayjs().add(10, "month").toDate(),
    },
  });

  // ── Wards & beds + Admission ────────────────────
  const wardGeneral = await prisma.ward.create({
    data: { tenantId: tenant.id, branchId: dhanmondi.id, name: "General Male Ward", floor: "2nd", type: WardType.GENERAL },
  });
  const wardCabin = await prisma.ward.create({
    data: { tenantId: tenant.id, branchId: dhanmondi.id, name: "Premium Cabin", floor: "3rd", type: WardType.CABIN },
  });
  const wardIcu = await prisma.ward.create({
    data: { tenantId: tenant.id, branchId: dhanmondi.id, name: "ICU", floor: "4th", type: WardType.ICU },
  });
  const beds: { id: string }[] = [];
  for (let i = 1; i <= 6; i++) {
    beds.push(await prisma.bed.create({
      data: { tenantId: tenant.id, wardId: wardGeneral.id, code: `GM-${String(i).padStart(2, "0")}`, dailyRate: 1200, status: i === 1 ? BedStatus.OCCUPIED : BedStatus.AVAILABLE },
    }));
  }
  for (let i = 1; i <= 4; i++) {
    beds.push(await prisma.bed.create({
      data: { tenantId: tenant.id, wardId: wardCabin.id, code: `CB-${String(i).padStart(2, "0")}`, dailyRate: 3500, status: i === 1 ? BedStatus.OCCUPIED : BedStatus.AVAILABLE },
    }));
  }
  for (let i = 1; i <= 4; i++) {
    beds.push(await prisma.bed.create({
      data: { tenantId: tenant.id, wardId: wardIcu.id, code: `ICU-${String(i).padStart(2, "0")}`, dailyRate: 7500, status: BedStatus.AVAILABLE },
    }));
  }

  // Active admission for Hasan Mahmud in General Ward bed 1
  const admInv = await prisma.invoice.create({
    data: {
      tenantId: tenant.id, branchId: dhanmondi.id, patientId: patients[4].id,
      invoiceNumber: `INV-${dayjs().format("YYMMDD")}-00100`,
      kind: "IPD", status: "DRAFT", subtotal: 0, totalAmount: 0, paidAmount: 0, dueAmount: 0,
    },
  });
  const admission1 = await prisma.admission.create({
    data: {
      tenantId: tenant.id, branchId: dhanmondi.id, patientId: patients[4].id,
      admittingDoctorId: surgeon.id, admissionNumber: admNo(1),
      admittedAt: dayjs().subtract(3, "day").toDate(),
      status: AdmissionStatus.ADMITTED,
      diagnosisOnAdmission: "Acute cholecystitis — for laparoscopic cholecystectomy",
      invoiceId: admInv.id,
    },
  });
  await prisma.bedAllocation.create({
    data: { admissionId: admission1.id, bedId: beds[0].id, fromTs: dayjs().subtract(3, "day").toDate() },
  });
  // 3 days of bed charges
  for (let d = 0; d < 3; d++) {
    await prisma.ipdCharge.create({
      data: {
        tenantId: tenant.id, admissionId: admission1.id,
        chargeDate: dayjs().subtract(3 - d, "day").toDate(),
        chargeType: IpdChargeType.BED, description: "General Ward bed (day rate)",
        qty: 1, unitPrice: 1200, amount: 1200,
        refTable: "beds", refId: beds[0].id, createdById: admin.id,
      },
    });
  }
  await prisma.doctorVisit.create({
    data: { tenantId: tenant.id, admissionId: admission1.id, doctorId: surgeon.id, visitAt: dayjs().subtract(2, "day").toDate(), note: "Reviewing pre-op labs. Plan: laparoscopic chole tomorrow.", fee: 1500 },
  });
  await prisma.nursingNote.create({
    data: {
      tenantId: tenant.id, admissionId: admission1.id, nurseId: nurse.id,
      note: "Patient stable. Vitals normal. NPO from midnight per anesthesia.",
      vitals: { bp: "120/80", pulse: 76, temp: "98.6F", spo2: 99 },
    },
  });

  // ── Blood Bank ──────────────────────────────────
  const donor1 = await prisma.bloodDonor.create({
    data: {
      tenantId: tenant.id, name: "Md. Rezaul Karim", phone: "01911222001",
      nid: "1990123456789", bloodGroup: BloodGroup.O_POS,
      dob: new Date("1990-01-15"), gender: Gender.MALE, address: "Mirpur 10, Dhaka",
      occupation: "Bank officer", totalDonations: 8,
      lastDonatedAt: dayjs().subtract(4, "month").toDate(),
    },
  });
  const donor2 = await prisma.bloodDonor.create({
    data: {
      tenantId: tenant.id, name: "Fahim Ahmed", phone: "01911222002",
      bloodGroup: BloodGroup.A_POS, gender: Gender.MALE, totalDonations: 3,
      lastDonatedAt: dayjs().subtract(2, "month").toDate(),
    },
  });
  const donor3 = await prisma.bloodDonor.create({
    data: {
      tenantId: tenant.id, name: "Suraiya Akter", phone: "01911222003",
      bloodGroup: BloodGroup.B_POS, gender: Gender.FEMALE, totalDonations: 2,
    },
  });

  const bag1 = await prisma.bloodBag.create({
    data: {
      tenantId: tenant.id, donorId: donor1.id, bagNumber: bagNo(1),
      bloodGroup: BloodGroup.O_POS, component: BloodComponent.WHOLE_BLOOD, volumeMl: 450,
      collectedOn: dayjs().subtract(10, "day").toDate(),
      expiryDate: dayjs().add(25, "day").toDate(),
      status: BloodBagStatus.AVAILABLE, storageLocation: "Refrigerator A / Shelf 1",
    },
  });
  await prisma.bloodScreening.create({
    data: { bagId: bag1.id, hbsAg: ScreeningResult.NEGATIVE, hiv: ScreeningResult.NEGATIVE, hcv: ScreeningResult.NEGATIVE, vdrl: ScreeningResult.NEGATIVE, malaria: ScreeningResult.NEGATIVE, testedById: labTech.id, testedAt: dayjs().subtract(9, "day").toDate() },
  });

  const bag2 = await prisma.bloodBag.create({
    data: {
      tenantId: tenant.id, donorId: donor2.id, bagNumber: bagNo(2),
      bloodGroup: BloodGroup.A_POS, component: BloodComponent.PRBC, volumeMl: 250,
      collectedOn: dayjs().subtract(5, "day").toDate(),
      expiryDate: dayjs().add(30, "day").toDate(),
      status: BloodBagStatus.QUARANTINE, storageLocation: "Refrigerator A / Shelf 2",
    },
  });
  await prisma.bloodScreening.create({
    data: { bagId: bag2.id, hbsAg: ScreeningResult.PENDING, hiv: ScreeningResult.PENDING, hcv: ScreeningResult.PENDING, vdrl: ScreeningResult.PENDING, malaria: ScreeningResult.PENDING },
  });

  const bag3 = await prisma.bloodBag.create({
    data: {
      tenantId: tenant.id, donorId: donor3.id, bagNumber: bagNo(3),
      bloodGroup: BloodGroup.B_POS, component: BloodComponent.PLATELET, volumeMl: 60,
      collectedOn: dayjs().subtract(2, "day").toDate(),
      expiryDate: dayjs().add(3, "day").toDate(),
      status: BloodBagStatus.AVAILABLE,
    },
  });
  await prisma.bloodScreening.create({
    data: { bagId: bag3.id, hbsAg: ScreeningResult.NEGATIVE, hiv: ScreeningResult.NEGATIVE, hcv: ScreeningResult.NEGATIVE, vdrl: ScreeningResult.NEGATIVE, malaria: ScreeningResult.NEGATIVE, testedById: labTech.id },
  });

  // ── Ambulance ───────────────────────────────────
  const amb1 = await prisma.ambulance.create({
    data: {
      tenantId: tenant.id, branchId: dhanmondi.id,
      vehicleNumber: "DHA-METRO-LA-12-3456", type: AmbulanceType.AC,
      driverName: "Md. Liton Mia", driverPhone: "01911777001",
      baseRate: 1500, perKmRate: 30, fuelType: "Diesel",
    },
  });
  const amb2 = await prisma.ambulance.create({
    data: {
      tenantId: tenant.id, branchId: dhanmondi.id,
      vehicleNumber: "DHA-METRO-LA-22-1100", type: AmbulanceType.ICU,
      driverName: "Md. Jahangir", driverPhone: "01911777002",
      baseRate: 3000, perKmRate: 50, fuelType: "Diesel",
    },
  });
  await prisma.ambulance.create({
    data: {
      tenantId: tenant.id, branchId: uttara.id,
      vehicleNumber: "DHA-METRO-LA-33-7788", type: AmbulanceType.NON_AC,
      driverName: "Md. Bashir", driverPhone: "01911777003",
      baseRate: 1000, perKmRate: 25,
    },
  });
  await prisma.ambulanceTrip.create({
    data: {
      tenantId: tenant.id, ambulanceId: amb1.id, patientId: patients[4].id,
      pickup: "Hasan's residence, Banani",
      destination: "Popular Diagnostic Centre, Dhanmondi",
      distanceKm: 14.2, totalFee: 1500 + 14.2 * 30,
      startedAt: dayjs().subtract(3, "day").subtract(1, "hour").toDate(),
      completedAt: dayjs().subtract(3, "day").toDate(),
      status: AmbulanceTripStatus.COMPLETED,
      callerName: "Family", callerPhone: "01911111115",
      createdById: recep.id,
    },
  });
  await prisma.ambulanceTrip.create({
    data: {
      tenantId: tenant.id, ambulanceId: amb2.id, callerName: "Anonymous caller",
      callerPhone: "01911000999",
      pickup: "Dhanmondi Main", destination: "Square Hospital, Panthapath",
      distanceKm: 5, totalFee: 3000 + 5 * 50,
      startedAt: dayjs().subtract(30, "minute").toDate(),
      status: AmbulanceTripStatus.EN_ROUTE,
    },
  });

  // ── Vaccines + Patient Vaccinations (EPI) ──────
  const vaccBcg = await prisma.vaccine.create({
    data: { tenantId: tenant.id, code: "BCG", name: "BCG (Tuberculosis)", nameBn: "বিসিজি", doseNumber: 1, totalDoses: 1, recommendedAgeText: "At birth", isEpi: true, defaultFee: 0, manufacturer: "Govt. EPI" },
  });
  const vaccPenta = await prisma.vaccine.create({
    data: { tenantId: tenant.id, code: "PENTA-1", name: "Pentavalent (DPT-HepB-Hib) Dose 1", nameBn: "পেন্টাভ্যালেন্ট ১", doseNumber: 1, totalDoses: 3, recommendedAgeText: "6 weeks", nextDoseDays: 28, isEpi: true, defaultFee: 0 },
  });
  await prisma.vaccine.create({
    data: { tenantId: tenant.id, code: "PENTA-2", name: "Pentavalent Dose 2", doseNumber: 2, totalDoses: 3, recommendedAgeText: "10 weeks", nextDoseDays: 28, isEpi: true, defaultFee: 0 },
  });
  await prisma.vaccine.create({
    data: { tenantId: tenant.id, code: "PENTA-3", name: "Pentavalent Dose 3", doseNumber: 3, totalDoses: 3, recommendedAgeText: "14 weeks", isEpi: true, defaultFee: 0 },
  });
  await prisma.vaccine.create({
    data: { tenantId: tenant.id, code: "MR-1", name: "Measles-Rubella Dose 1", doseNumber: 1, totalDoses: 2, recommendedAgeText: "9 months", nextDoseDays: 90, isEpi: true, defaultFee: 0 },
  });
  await prisma.vaccine.create({
    data: { tenantId: tenant.id, code: "HPV", name: "HPV (Cervical Cancer)", doseNumber: 1, totalDoses: 1, recommendedAgeText: "9-14 yrs (girls)", isEpi: false, defaultFee: 2500, manufacturer: "GSK Cervarix" },
  });
  await prisma.vaccine.create({
    data: { tenantId: tenant.id, code: "COVID-BOOSTER", name: "COVID-19 Booster", doseNumber: 1, totalDoses: 1, recommendedAgeText: "Adult", isEpi: false, defaultFee: 500 },
  });
  await prisma.patientVaccination.create({
    data: {
      tenantId: tenant.id, patientId: patients[9].id, vaccineId: vaccBcg.id,
      givenAt: dayjs(patients[9].dob!).add(7, "day").toDate(),
      batchNumber: "EPI-BCG-2018-A1", givenById: nurse.id,
    },
  });
  await prisma.patientVaccination.create({
    data: {
      tenantId: tenant.id, patientId: patients[9].id, vaccineId: vaccPenta.id,
      givenAt: dayjs(patients[9].dob!).add(42, "day").toDate(),
      batchNumber: "EPI-PENTA-2018-B7", givenById: nurse.id,
      nextDueAt: dayjs(patients[9].dob!).add(70, "day").toDate(),
    },
  });

  // ── Operating Theatre ───────────────────────────
  const ot1 = await prisma.operatingRoom.create({
    data: { tenantId: tenant.id, branchId: dhanmondi.id, name: "OT 1 — Major", notes: "Laminar flow, fully equipped" },
  });
  await prisma.operatingRoom.create({
    data: { tenantId: tenant.id, branchId: dhanmondi.id, name: "OT 2 — Minor", notes: "Day-case procedures" },
  });
  await prisma.otBooking.create({
    data: {
      tenantId: tenant.id, operatingRoomId: ot1.id,
      admissionId: admission1.id, patientId: patients[4].id, surgeonId: surgeon.id,
      procedureName: "Laparoscopic Cholecystectomy",
      anesthesiaType: "General Anesthesia",
      anesthesiologistId: cardiologist.id,
      assistantIds: [doctor.id], nurseIds: [nurse.id],
      scheduledStart: dayjs().add(1, "day").hour(10).toDate(),
      scheduledEnd: dayjs().add(1, "day").hour(12).toDate(),
      status: OtBookingStatus.SCHEDULED, fee: 35000,
    },
  });
  await prisma.otBooking.create({
    data: {
      tenantId: tenant.id, operatingRoomId: ot1.id,
      patientId: patients[1].id, surgeonId: gyne.id,
      procedureName: "Diagnostic Hysteroscopy",
      anesthesiaType: "Spinal Anesthesia",
      assistantIds: [], nurseIds: [nurse.id],
      scheduledStart: dayjs().subtract(2, "day").hour(14).toDate(),
      scheduledEnd: dayjs().subtract(2, "day").hour(15).toDate(),
      actualStart: dayjs().subtract(2, "day").hour(14).minute(5).toDate(),
      actualEnd: dayjs().subtract(2, "day").hour(15).minute(30).toDate(),
      status: OtBookingStatus.COMPLETED, fee: 12000,
    },
  });

  // ── Expenses (history for finance reports) ──────
  await prisma.expense.createMany({
    data: [
      { tenantId: tenant.id, branchId: dhanmondi.id, spentOn: dayjs().subtract(7, "day").toDate(), category: ExpenseCategory.RENT, description: "Dhanmondi office rent (March)", amount: 80000, paidVia: PaymentMethod.BANK_TRANSFER, vendorName: "Landlord", recordedById: accountant.id },
      { tenantId: tenant.id, branchId: dhanmondi.id, spentOn: dayjs().subtract(5, "day").toDate(), category: ExpenseCategory.UTILITIES, description: "DESCO electricity", amount: 14500, paidVia: PaymentMethod.BKASH, recordedById: accountant.id },
      { tenantId: tenant.id, branchId: dhanmondi.id, spentOn: dayjs().subtract(3, "day").toDate(), category: ExpenseCategory.SUPPLIES, description: "Sterile gloves x 1000", amount: 6500, paidVia: PaymentMethod.CASH, vendorName: "Sun Surgical", recordedById: pharmacist.id },
      { tenantId: tenant.id, branchId: uttara.id, spentOn: dayjs().subtract(2, "day").toDate(), category: ExpenseCategory.MAINTENANCE, description: "AC servicing", amount: 3200, paidVia: PaymentMethod.CASH, recordedById: accountant.id },
      { tenantId: tenant.id, branchId: dhanmondi.id, spentOn: dayjs().subtract(1, "day").toDate(), category: ExpenseCategory.MARKETING, description: "Local newspaper ad", amount: 12000, paidVia: PaymentMethod.BANK_TRANSFER, vendorName: "Prothom Alo", recordedById: admin.id },
    ],
  });

  // ── Cash close (yesterday, closed; today, open) ──
  await prisma.cashClose.create({
    data: {
      tenantId: tenant.id, branchId: dhanmondi.id, cashierId: recep.id,
      openedAt: dayjs().subtract(1, "day").hour(9).toDate(),
      closedAt: dayjs().subtract(1, "day").hour(21).toDate(),
      status: CashCloseStatus.CLOSED,
      openingFloat: 5000, expectedCash: 22500, declaredCash: 22500, variance: 0,
      cashTotal: 17500, bkashTotal: 8000, nagadTotal: 2500, cardTotal: 5000,
      notes: "Smooth day. All counts matched.",
    },
  });
  await prisma.cashClose.create({
    data: {
      tenantId: tenant.id, branchId: dhanmondi.id, cashierId: recep.id,
      openedAt: dayjs().hour(9).toDate(), status: CashCloseStatus.OPEN,
      openingFloat: 5000,
    },
  });

  // ── Petty cash ──────────────────────────────────
  await prisma.pettyCashEntry.createMany({
    data: [
      { tenantId: tenant.id, branchId: dhanmondi.id, type: PettyCashType.TOP_UP, amount: 5000, description: "Opening top-up", voucherNo: "PC-001", recordedById: accountant.id, occurredOn: dayjs().subtract(7, "day").toDate() },
      { tenantId: tenant.id, branchId: dhanmondi.id, type: PettyCashType.PAYOUT, amount: 350, description: "Tea & snacks for staff meeting", voucherNo: "PC-002", recordedById: recep.id, occurredOn: dayjs().subtract(4, "day").toDate() },
      { tenantId: tenant.id, branchId: dhanmondi.id, type: PettyCashType.PAYOUT, amount: 600, description: "Stationery — printer paper", voucherNo: "PC-003", recordedById: recep.id, occurredOn: dayjs().subtract(2, "day").toDate() },
      { tenantId: tenant.id, branchId: dhanmondi.id, type: PettyCashType.TOP_UP, amount: 2000, description: "Replenishment", voucherNo: "PC-004", recordedById: accountant.id, occurredOn: dayjs().subtract(1, "day").toDate() },
    ],
  });

  // ── Commission payouts ──────────────────────────
  await prisma.commissionPayout.create({
    data: {
      tenantId: tenant.id, referrerId: refDr1.id, payeeName: "Dr. Imran Khan",
      periodFrom: dayjs().subtract(1, "month").startOf("month").toDate(),
      periodTo: dayjs().subtract(1, "month").endOf("month").toDate(),
      amount: 4500, method: PaymentMethod.BKASH, referenceNo: "BKS22334455",
      orderIds: [order1.id], paidById: accountant.id, notes: "Feb '26 commission",
    },
  });

  // ── Patient Feedback ────────────────────────────
  await prisma.patientFeedback.createMany({
    data: [
      { tenantId: tenant.id, patientId: patients[0].id, type: FeedbackType.FEEDBACK, rating: 5, subject: "Excellent service", message: "Got my CBC report within 4 hours. Staff was very polite. Thank you!", status: FeedbackStatus.OPEN },
      { tenantId: tenant.id, patientId: patients[1].id, type: FeedbackType.COMPLAINT, rating: 2, subject: "Long wait time", message: "Waited over 90 minutes for sample collection. Please improve queue management.", status: FeedbackStatus.IN_PROGRESS, assignedToId: hrMgr.id },
      { tenantId: tenant.id, type: FeedbackType.SUGGESTION, visitorName: "Anonymous visitor", visitorPhone: "01911000444", subject: "Add evening shift counter", message: "Would be helpful if billing counter stays open till 10 pm for working professionals.", status: FeedbackStatus.OPEN },
      { tenantId: tenant.id, patientId: patients[3].id, type: FeedbackType.FEEDBACK, rating: 4, subject: "Nice clinic", message: "Doctor was thorough. Slightly expensive but worth it.", status: FeedbackStatus.RESOLVED, response: "Thank you for the positive feedback!", respondedAt: new Date(), assignedToId: admin.id },
    ],
  });

  // ── Phase D: HR ─────────────────────────────────
  const year = dayjs().year();

  // Employment terms for all real staff
  const termsData: Array<{ user: typeof admin; basic: number; ha: number; ma: number; ta: number; tax: number; pf: number }> = [
    { user: admin, basic: 60000, ha: 24000, ma: 5000, ta: 4000, tax: 10, pf: 5 },
    { user: recep, basic: 18000, ha: 7200, ma: 1500, ta: 1500, tax: 0, pf: 5 },
    { user: labTech, basic: 22000, ha: 8800, ma: 1500, ta: 2000, tax: 0, pf: 5 },
    { user: doctor, basic: 80000, ha: 30000, ma: 6000, ta: 4000, tax: 10, pf: 5 },
    { user: accountant, basic: 30000, ha: 12000, ma: 2000, ta: 2500, tax: 5, pf: 5 },
    { user: nurse, basic: 20000, ha: 8000, ma: 1500, ta: 1500, tax: 0, pf: 5 },
    { user: pharmacist, basic: 25000, ha: 10000, ma: 2000, ta: 2000, tax: 0, pf: 5 },
    { user: hrMgr, basic: 40000, ha: 16000, ma: 2500, ta: 2500, tax: 5, pf: 5 },
    { user: surgeon, basic: 120000, ha: 48000, ma: 8000, ta: 6000, tax: 15, pf: 5 },
    { user: cardiologist, basic: 100000, ha: 40000, ma: 7000, ta: 5000, tax: 12, pf: 5 },
    { user: gyne, basic: 90000, ha: 36000, ma: 6000, ta: 5000, tax: 10, pf: 5 },
  ];
  for (const t of termsData) {
    const gross = t.basic + t.ha + t.ma + t.ta;
    const tax = (gross * t.tax) / 100;
    const pf = (t.basic * t.pf) / 100;
    const estimatedNet = gross - tax - pf;
    await prisma.employmentTerms.create({
      data: {
        userId: t.user.id, employmentType: EmploymentType.FULL_TIME,
        designation: t.user.designation, joinedAt: dayjs().subtract(2, "year").toDate(),
        basicSalary: t.basic, houseAllowance: t.ha, medicalAllowance: t.ma,
        transportAllowance: t.ta, taxDeductionPercent: t.tax, pfEmployeePercent: t.pf,
        pfEmployerPercent: t.pf, estimatedNet,
      },
    });
  }

  // Leave types
  const ltCasual = await prisma.leaveType.create({
    data: { tenantId: tenant.id, code: "CL", name: "Casual Leave", daysPerYear: 10, paid: true },
  });
  const ltSick = await prisma.leaveType.create({
    data: { tenantId: tenant.id, code: "SL", name: "Sick Leave", daysPerYear: 14, paid: true },
  });
  const ltAnnual = await prisma.leaveType.create({
    data: { tenantId: tenant.id, code: "AL", name: "Annual Leave", daysPerYear: 20, paid: true, carryForward: true },
  });
  await prisma.leaveType.create({
    data: { tenantId: tenant.id, code: "ML", name: "Maternity Leave", daysPerYear: 112, paid: true },
  });
  await prisma.leaveType.create({
    data: { tenantId: tenant.id, code: "LWP", name: "Leave Without Pay", daysPerYear: 0, paid: false },
  });

  // Leave balances + a couple of requests
  for (const u of allStaff) {
    for (const lt of [ltCasual, ltSick, ltAnnual]) {
      await prisma.leaveBalance.create({
        data: { userId: u.id, leaveTypeId: lt.id, year, allocated: lt.daysPerYear, used: 0 },
      });
    }
  }
  // Recep took 2 days casual leave (approved)
  await prisma.leaveRequest.create({
    data: {
      tenantId: tenant.id, userId: recep.id, leaveTypeId: ltCasual.id,
      fromDate: dayjs().subtract(20, "day").toDate(),
      toDate: dayjs().subtract(19, "day").toDate(),
      days: 2, reason: "Family event", status: LeaveStatus.APPROVED,
      reviewedById: hrMgr.id, reviewedAt: dayjs().subtract(22, "day").toDate(),
      reviewNote: "Approved.",
    },
  });
  await prisma.leaveBalance.update({
    where: { userId_leaveTypeId_year: { userId: recep.id, leaveTypeId: ltCasual.id, year } },
    data: { used: 2 },
  });
  // Labtech requested 1 day sick (pending)
  await prisma.leaveRequest.create({
    data: {
      tenantId: tenant.id, userId: labTech.id, leaveTypeId: ltSick.id,
      fromDate: dayjs().add(2, "day").toDate(),
      toDate: dayjs().add(2, "day").toDate(),
      days: 1, reason: "Medical check-up", status: LeaveStatus.PENDING,
    },
  });

  // Staff loan
  await prisma.staffLoan.create({
    data: {
      tenantId: tenant.id, userId: nurse.id, principal: 30000,
      monthlyDeduction: 5000, totalDeducted: 10000, status: LoanStatus.ACTIVE,
      reason: "Emergency family medical bill", takenOn: dayjs().subtract(2, "month").toDate(),
    },
  });

  // Attendance — last 7 days for all staff
  for (const u of allStaff) {
    for (let d = 7; d >= 1; d--) {
      const date = dayjs().subtract(d, "day").startOf("day");
      const dow = date.day(); // 0=Sun
      const status =
        dow === 5 ? AttendanceStatus.WEEKEND : // Friday in BD context
        (u.id === recep.id && d === 20) ? AttendanceStatus.LEAVE :
        AttendanceStatus.PRESENT;
      await prisma.attendance.create({
        data: {
          tenantId: tenant.id, branchId: dhanmondi.id, userId: u.id,
          date: date.toDate(), status,
          checkIn: status === AttendanceStatus.PRESENT ? date.hour(9).minute(5).toDate() : null,
          checkOut: status === AttendanceStatus.PRESENT ? date.hour(18).minute(15).toDate() : null,
          recordedById: hrMgr.id,
        },
      });
    }
  }

  // Roster shifts + a week of duty roster
  const shiftMorning = await prisma.dutyShift.create({
    data: { tenantId: tenant.id, branchId: dhanmondi.id, code: "M", name: "Morning", startTime: "08:00", endTime: "16:00", colorHex: "#60a5fa" },
  });
  const shiftEvening = await prisma.dutyShift.create({
    data: { tenantId: tenant.id, branchId: dhanmondi.id, code: "E", name: "Evening", startTime: "16:00", endTime: "00:00", colorHex: "#f59e0b" },
  });
  const shiftNight = await prisma.dutyShift.create({
    data: { tenantId: tenant.id, branchId: dhanmondi.id, code: "N", name: "Night", startTime: "00:00", endTime: "08:00", colorHex: "#6366f1" },
  });
  await prisma.dutyShift.create({
    data: { tenantId: tenant.id, branchId: dhanmondi.id, code: "OFF", name: "Off", startTime: "00:00", endTime: "00:00", colorHex: "#9ca3af" },
  });
  // Next 5 days — nurse rotates M / E / N / M / E
  const rotation = [shiftMorning, shiftEvening, shiftNight, shiftMorning, shiftEvening];
  for (let d = 0; d < 5; d++) {
    await prisma.dutyRoster.create({
      data: {
        tenantId: tenant.id, branchId: dhanmondi.id,
        userId: nurse.id, shiftId: rotation[d].id,
        date: dayjs().add(d, "day").toDate(),
      },
    });
    await prisma.dutyRoster.create({
      data: {
        tenantId: tenant.id, branchId: dhanmondi.id,
        userId: labTech.id, shiftId: d % 2 === 0 ? shiftMorning.id : shiftEvening.id,
        date: dayjs().add(d, "day").toDate(),
      },
    });
  }

  // Payroll run — previous month, finalized
  const prevMonth = dayjs().subtract(1, "month");
  const payRun = await prisma.payrollRun.create({
    data: {
      tenantId: tenant.id, branchId: dhanmondi.id,
      periodYear: prevMonth.year(), periodMonth: prevMonth.month() + 1,
      status: PayrollRunStatus.FINALIZED,
      createdById: hrMgr.id, finalizedById: admin.id,
      finalizedAt: prevMonth.endOf("month").toDate(),
      notes: "March '26 payroll — fully processed.",
      totalGross: 0, totalNet: 0, totalDeductions: 0,
    },
  });

  let totalGross = 0, totalNet = 0, totalDed = 0;
  for (const t of termsData) {
    const gross = t.basic + t.ha + t.ma + t.ta;
    const tax = (gross * t.tax) / 100;
    const pf = (t.basic * t.pf) / 100;
    const net = gross - tax - pf;
    totalGross += gross; totalNet += net; totalDed += (tax + pf);
    await prisma.payslip.create({
      data: {
        payrollRunId: payRun.id, userId: t.user.id,
        designation: t.user.designation,
        basicSalary: t.basic, houseAllowance: t.ha, medicalAllowance: t.ma,
        transportAllowance: t.ta, otherAllowances: 0,
        daysInMonth: 30, daysPresent: 26, daysAbsent: 0, daysLeavePaid: 4, daysLeaveUnpaid: 0,
        lopAmount: 0, taxDeduction: tax, pfDeduction: pf, loanDeduction: 0, otherDeduction: 0,
        grossSalary: gross, totalDeductions: tax + pf, netSalary: net,
        status: t.user.id === nurse.id ? PayslipStatus.PENDING : PayslipStatus.PAID,
        paidAt: t.user.id === nurse.id ? null : prevMonth.endOf("month").toDate(),
        paidVia: t.user.id === nurse.id ? null : PaymentMethod.BANK_TRANSFER,
        paidById: t.user.id === nurse.id ? null : accountant.id,
      },
    });
  }
  await prisma.payrollRun.update({
    where: { id: payRun.id },
    data: { totalGross, totalNet, totalDeductions: totalDed },
  });

  // ── SaaS: subscription invoices for Popular ─────────
  // Two paid historic invoices + one currently-issued so the platform admin
  // sees both the success path and a pending bill they can take payment on.
  console.log("  · seeding subscription invoices...");
  const monthOf = (offset: number) => dayjs().startOf("month").subtract(offset, "month");
  for (let i = 2; i >= 1; i--) {
    const periodFrom = monthOf(i).toDate();
    const periodTo = monthOf(i).endOf("month").toDate();
    const inv = await prisma.subscriptionInvoice.create({
      data: {
        tenantId: tenant.id,
        invoiceNumber: `SUB-${dayjs(periodFrom).format("YYMM")}-0001`,
        periodFrom, periodTo,
        dueDate: dayjs(periodFrom).add(14, "day").toDate(),
        status: SubscriptionInvoiceStatus.PAID,
        planCode: "MEDIUM", planName: "Medium",
        billingCycle: BillingCycle.MONTHLY,
        subtotal: 8000, discountAmount: 0, totalAmount: 8000,
        paidAmount: 8000, dueAmount: 0,
        paidAt: dayjs(periodFrom).add(5, "day").toDate(),
        lines: {
          create: [{
            description: `Medium subscription · ${dayjs(periodFrom).format("DD MMM YYYY")} – ${dayjs(periodTo).format("DD MMM YYYY")}`,
            qty: 1, unitPrice: 8000, amount: 8000,
          }],
        },
      },
    });
    await prisma.subscriptionInvoicePayment.create({
      data: {
        invoiceId: inv.id,
        amount: 8000,
        method: PaymentMethod.BKASH,
        referenceNo: `BK${dayjs(periodFrom).format("YYMM")}XX${1000 + i}`,
        paidAt: dayjs(periodFrom).add(5, "day").toDate(),
      },
    });
  }
  // Current month — still due
  const currentFrom = dayjs().startOf("month").toDate();
  const currentTo = dayjs().endOf("month").toDate();
  await prisma.subscriptionInvoice.create({
    data: {
      tenantId: tenant.id,
      invoiceNumber: `SUB-${dayjs().format("YYMM")}-0001`,
      periodFrom: currentFrom, periodTo: currentTo,
      dueDate: dayjs().add(14, "day").toDate(),
      status: SubscriptionInvoiceStatus.ISSUED,
      planCode: "MEDIUM", planName: "Medium",
      billingCycle: BillingCycle.MONTHLY,
      subtotal: 8000, discountAmount: 0, totalAmount: 8000,
      paidAmount: 0, dueAmount: 8000,
      lines: {
        create: [{
          description: `Medium subscription · ${dayjs(currentFrom).format("DD MMM YYYY")} – ${dayjs(currentTo).format("DD MMM YYYY")}`,
          qty: 1, unitPrice: 8000, amount: 8000,
        }],
      },
    },
  });

  // ── Corporate clients ────────────────────────────────
  console.log("  · seeding corporate clients...");
  const grameenphone = await prisma.corporateClient.create({
    data: {
      tenantId: tenant.id,
      name: "Grameenphone Ltd.",
      type: CorporateClientType.COMPANY,
      contactPerson: "HR Department",
      phone: "+8801711100100",
      email: "hr@grameenphone.local",
      address: "GP House, Bashundhara, Dhaka",
      taxId: "BIN-122456",
      discountPercent: 10,
      creditLimit: 100000,
      paymentTermsDays: 30,
      isActive: true,
      notes: "Bulk monthly billing on the 5th. Employee card required.",
    },
  });
  await prisma.corporateClient.create({
    data: {
      tenantId: tenant.id,
      name: "Green Delta Insurance",
      type: CorporateClientType.INSURANCE,
      contactPerson: "Claims Dept.",
      phone: "+8801712200200",
      email: "claims@greendelta.local",
      address: "Hadi Mansion, Dilkusha, Dhaka",
      taxId: "BIN-887766",
      discountPercent: 15,
      creditLimit: 200000,
      paymentTermsDays: 45,
      isActive: true,
    },
  });

  // Link two existing patients to Grameenphone so the corporate detail page
  // has linked-patient rows to render.
  if (patients[0]) {
    await prisma.patient.update({
      where: { id: patients[0].id },
      data: { corporateClientId: grameenphone.id, corporateEmpId: "GP-EMP-1001" },
    });
  }
  if (patients[1]) {
    await prisma.patient.update({
      where: { id: patients[1].id },
      data: { corporateClientId: grameenphone.id, corporateEmpId: "GP-EMP-1002" },
    });
  }

  // One open statement for Grameenphone so /corporate/[id] has data to render.
  await prisma.corporateStatement.create({
    data: {
      tenantId: tenant.id,
      clientId: grameenphone.id,
      statementNumber: `CST-${dayjs().subtract(1, "month").format("YYMMDD")}-0001`,
      periodFrom: dayjs().subtract(1, "month").startOf("month").toDate(),
      periodTo: dayjs().subtract(1, "month").endOf("month").toDate(),
      invoiceIds: [],
      subtotal: 12500, discountAmount: 1250, netPayable: 11250,
      paidAmount: 0, dueAmount: 11250,
      status: CorporateStatementStatus.GENERATED,
      dueDate: dayjs().add(15, "day").toDate(),
      generatedAt: dayjs().subtract(1, "week").toDate(),
    },
  });

  // ── Support tickets ──────────────────────────────────
  console.log("  · seeding support tickets...");
  // Need to know an admin user to author tickets — re-fetch since `admin` is
  // already in scope from earlier in this function.
  const t1 = await prisma.supportTicket.create({
    data: {
      tenantId: tenant.id,
      ticketNumber: `SUP-${dayjs().subtract(3, "day").format("YYMMDD")}-0001`,
      title: "Cannot generate report PDF for some patients",
      category: SupportTicketCategory.BUG,
      severity: SupportTicketSeverity.HIGH,
      status: SupportTicketStatus.IN_PROGRESS,
      createdById: admin.id,
      lastMessageAt: dayjs().subtract(1, "day").toDate(),
      lastMessageSide: SupportMessageSide.PLATFORM,
      platformUnread: false,
      tenantUnread: true,
    },
  });
  await prisma.supportTicketMessage.create({
    data: {
      ticketId: t1.id,
      side: SupportMessageSide.TENANT,
      authorId: admin.id,
      authorName: admin.name,
      body: "When I click Download PDF on report #RPT-12345 nothing happens. Tried on 3 patients today, same problem. Browser is Chrome on Windows.",
      createdAt: dayjs().subtract(3, "day").toDate(),
    },
  });
  await prisma.supportTicketMessage.create({
    data: {
      ticketId: t1.id,
      side: SupportMessageSide.PLATFORM,
      authorId: admin.id,
      authorName: "Platform Support",
      body: "Thanks for the report. Looking into it now — can you share which test types those reports were for? Asking to narrow down the PDF template version.",
      createdAt: dayjs().subtract(1, "day").toDate(),
    },
  });

  await prisma.supportTicket.create({
    data: {
      tenantId: tenant.id,
      ticketNumber: `SUP-${dayjs().subtract(5, "day").format("YYMMDD")}-0002`,
      title: "Please add Radiology module to our plan",
      category: SupportTicketCategory.FEATURE_REQUEST,
      severity: SupportTicketSeverity.MEDIUM,
      status: SupportTicketStatus.RESOLVED,
      createdById: admin.id,
      lastMessageAt: dayjs().subtract(2, "day").toDate(),
      lastMessageSide: SupportMessageSide.PLATFORM,
      platformUnread: false,
      tenantUnread: false,
      resolvedAt: dayjs().subtract(2, "day").toDate(),
      messages: {
        create: [
          {
            side: SupportMessageSide.TENANT,
            authorId: admin.id,
            authorName: admin.name,
            body: "We just bought an USG machine and want to start using the radiology module. Can you enable it?",
            createdAt: dayjs().subtract(5, "day").toDate(),
          },
          {
            side: SupportMessageSide.PLATFORM,
            authorId: admin.id,
            authorName: "Platform Support",
            body: "Radiology is already included in your Medium plan. I've granted it as a per-tenant override so you can start using it immediately. Sidebar will show it after a refresh.",
            createdAt: dayjs().subtract(2, "day").toDate(),
          },
        ],
      },
    },
  });

  await prisma.supportTicket.create({
    data: {
      tenantId: tenant.id,
      ticketNumber: `SUP-${dayjs().format("YYMMDD")}-0003`,
      title: "How to mark an invoice as partially paid?",
      category: SupportTicketCategory.QUESTION,
      severity: SupportTicketSeverity.LOW,
      status: SupportTicketStatus.RECEIVED,
      createdById: recep.id,
      lastMessageAt: dayjs().subtract(1, "hour").toDate(),
      lastMessageSide: SupportMessageSide.TENANT,
      platformUnread: true,
      tenantUnread: false,
      messages: {
        create: [{
          side: SupportMessageSide.TENANT,
          authorId: recep.id,
          authorName: recep.name,
          body: "A patient paid 2,000 out of 5,000 today and will pay the rest next week. How do I record the partial payment so the invoice shows 3,000 due?",
          createdAt: dayjs().subtract(1, "hour").toDate(),
        }],
      },
    },
  });

  // ── Second tenant on TRIAL for platform admin variety ─
  // A lightweight second clinic so the platform admin's tenant list, plans,
  // and revenue breakdown have more than one row to render.
  console.log("  · seeding second tenant (LabConnect, on trial)...");
  const trialEnd = dayjs().add(10, "day").toDate();
  const tenant2 = await prisma.tenant.create({
    data: {
      name: "LabConnect Diagnostics",
      slug: "labconnect",
      contactEmail: "hello@labconnect.local",
      contactPhone: "+8801800200200",
      address: "Plot 5, Mirpur 10, Dhaka",
      platformNotes: "Reached out via website. Owner is Dr. Kamal Hossain — interested in pharmacy module too.",
      subscription: {
        create: {
          planConfigId: smallPlan.id,
          plan: SubscriptionPlan.SMALL,
          status: SubscriptionStatus.TRIAL,
          billingCycle: BillingCycle.MONTHLY,
          monthlyPrice: smallPlan.monthlyPrice,
          maxBranches: smallPlan.maxBranches,
          maxUsers: smallPlan.maxUsers,
          maxPatientsMonth: smallPlan.maxPatientsMonth,
          maxStorageGb: smallPlan.maxStorageGb,
          billingCycleStart: dayjs().subtract(4, "day").toDate(),
          billingCycleEnd: trialEnd,
          trialEndsAt: trialEnd,
          nextBillingDate: trialEnd,
        },
      },
    },
  });
  const tenant2Branch = await prisma.branch.create({
    data: { tenantId: tenant2.id, name: "Mirpur Main", code: "MAIN" },
  });
  await prisma.user.create({
    data: {
      tenantId: tenant2.id,
      branchId: tenant2Branch.id,
      name: "Dr. Kamal Hossain",
      phone: "01800200200",
      email: "kamal@labconnect.local",
      passwordHash: await hash("trial123"),
      role: UserRole.SUPER_ADMIN,
      designation: "Owner",
    },
  });
  await prisma.subscriptionEvent.create({
    data: {
      tenantId: tenant2.id,
      eventType: "SIGNUP",
      notes: `Signup via web. Trial until ${dayjs(trialEnd).format("YYYY-MM-DD")}.`,
    },
  });

  console.log("\n  ✅  Seed complete.\n");
  console.log("  ─── Platform (software owner) ───");
  console.log("  Platform Admin: 01900000000 / platform123  → lands on /platform");
  console.log("");
  console.log("  ─── Popular Diagnostic Centre (slug: popular) ───");
  console.log("  Super Admin   : 01700000000 / admin123");
  console.log("  Receptionist  : 01700000001 / recep123");
  console.log("  Lab Tech      : 01700000002 / lab123");
  console.log("  Doctor        : 01700000003 / doctor123");
  console.log("  Accountant    : 01700000004 / acct123");
  console.log("  Nurse         : 01700000005 / nurse123");
  console.log("  Pharmacist    : 01700000006 / pharma123");
  console.log("  HR Manager    : 01700000007 / hr123");
  console.log("  Surgeon       : 01700000008 / doctor123");
  console.log("  Cardiologist  : 01700000009 / doctor123");
  console.log("  Gynaecologist : 01700000010 / doctor123 (Uttara branch)");
  console.log("");
  console.log("  ─── LabConnect Diagnostics (slug: labconnect, on TRIAL) ───");
  console.log("  Trial Owner   : 01800200200 / trial123");
  console.log("");
  console.log("  Patient portal: tenant slug \"popular\", phone 01911111111 (OTP printed in server logs)");
  console.log("");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
