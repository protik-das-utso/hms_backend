import rateLimit from "express-rate-limit";
import { Request } from "express";
import { isProd } from "../config/env";

// IPv6-safe IP normalization. express-rate-limit's default keyGenerator does
// the same; we re-implement here because we want to combine IP with another
// dimension (phone) for some limiters.
const normaliseIp = (ip: string | undefined): string => {
  const raw = (ip ?? "0.0.0.0").trim();
  // Strip IPv4-in-IPv6 prefix.
  if (raw.startsWith("::ffff:")) return raw.slice(7);
  // Bucket IPv6 by /64 so a single attacker can't cycle suffixes.
  if (raw.includes(":")) {
    const parts = raw.split(":");
    return parts.slice(0, 4).join(":") + "::/64";
  }
  return raw;
};

const phoneAndIp = (req: Request) => {
  const ip = normaliseIp(req.ip);
  const phone = (req.body?.phone ?? req.body?.email ?? "").toString().slice(0, 32);
  return `${ip}|${phone}`;
};

const ipOnly = (req: Request) => normaliseIp(req.ip);

const stdMessage = {
  status: "error",
  message: "Too many requests. Please slow down and try again shortly.",
};

/** Login + platform-login: 8 attempts / 5 min per IP+phone. */
export const loginLimiter = rateLimit({
  windowMs: 5 * 60_000,
  limit: isProd ? 8 : 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: phoneAndIp,
  message: stdMessage,
});

/**
 * OTP request (forgot-password, patient-portal). The OTP itself is 6 digits
 * — we MUST cap how often a phone can ask for one or attackers can sweep
 * the keyspace by repeatedly requesting fresh codes.
 */
export const otpRequestLimiter = rateLimit({
  windowMs: 60 * 60_000, // 1h
  limit: isProd ? 5 : 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: phoneAndIp,
  message: stdMessage,
});

/** OTP verify (reset-password, patient verify). 10 / 15 min keeps brute force impractical. */
export const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: isProd ? 10 : 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: phoneAndIp,
  message: stdMessage,
});

/** Signup throttle — prevents tenant-creation spam from a single IP. */
export const signupLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: isProd ? 5 : 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: ipOnly,
  message: stdMessage,
});

/** Generic global limiter applied to the whole API (1000 / 15min per IP). */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: isProd ? 1000 : 10_000,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: ipOnly,
  message: stdMessage,
});
