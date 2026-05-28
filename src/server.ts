import { createApp } from "./app";
import { env } from "./config/env";
import { prisma } from "./config/db";
import { startIpdDailyCharges, stopIpdDailyCharges } from "./jobs/ipdDailyCharges";
import { startAppointmentReminders, stopAppointmentReminders } from "./jobs/appointmentReminders";
import { startSubscriptionLifecycle, stopSubscriptionLifecycle } from "./jobs/subscriptionLifecycle";
import { startClinicOpsAlerts, stopClinicOpsAlerts } from "./jobs/clinicOpsAlerts";

const app = createApp();

const server = app.listen(env.port, () => {
  console.log(`\n  ${env.appName}`);
  console.log(`  ─────────────────────────────────────────`);
  console.log(`  Env:  ${env.nodeEnv}`);
  console.log(`  URL:  http://localhost:${env.port}${env.apiPrefix}`);
  console.log(`  Docs: http://localhost:${env.port}/health\n`);
  startIpdDailyCharges();
  startAppointmentReminders();
  startSubscriptionLifecycle();
  startClinicOpsAlerts();
});

const shutdown = async (signal: string) => {
  console.log(`\n[${signal}] Shutting down...`);
  stopIpdDailyCharges();
  stopAppointmentReminders();
  stopSubscriptionLifecycle();
  stopClinicOpsAlerts();
  server.close(() => console.log("HTTP server closed"));
  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
