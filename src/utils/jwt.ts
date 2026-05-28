import jwt, { SignOptions, VerifyOptions } from "jsonwebtoken";
import { env } from "../config/env";

export interface AccessPayload {
  sub: string; // userId
  tenantId: string;
  role: string;
  branchId?: string | null;
}

export interface RefreshPayload {
  sub: string;
  tokenId: string;
}

// Pinning algorithm = HS256 prevents the "alg: none" and HS-vs-RS confusion
// attacks. Some jsonwebtoken versions accept any algorithm by default on
// verify, which is a known footgun.
const accessOpts: SignOptions = {
  expiresIn: env.jwt.accessExpires as SignOptions["expiresIn"],
  algorithm: "HS256",
};
const refreshOpts: SignOptions = {
  expiresIn: env.jwt.refreshExpires as SignOptions["expiresIn"],
  algorithm: "HS256",
};
const verifyOpts: VerifyOptions = { algorithms: ["HS256"] };

export const signAccessToken = (payload: AccessPayload) =>
  jwt.sign(payload, env.jwt.accessSecret, accessOpts);

export const signRefreshToken = (payload: RefreshPayload) =>
  jwt.sign(payload, env.jwt.refreshSecret, refreshOpts);

export const verifyAccessToken = (token: string): AccessPayload =>
  jwt.verify(token, env.jwt.accessSecret, verifyOpts) as AccessPayload;

export const verifyRefreshToken = (token: string): RefreshPayload =>
  jwt.verify(token, env.jwt.refreshSecret, verifyOpts) as RefreshPayload;
