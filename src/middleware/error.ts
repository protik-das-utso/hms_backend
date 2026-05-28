import { Request, Response, NextFunction } from "express";
import { ApiError } from "../utils/ApiError";
import { Prisma } from "@prisma/client";
import { isProd } from "../config/env";

export const notFound = (req: Request, _res: Response, next: NextFunction) =>
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));

export const errorHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
) => {
  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({
      status: "error",
      message: err.message,
      errors: err.details ?? null,
    });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      // Don't leak Prisma's literal column names to clients in prod — it
      // exposes the schema. In dev we still surface them for debugging.
      return res.status(409).json({
        status: "error",
        message: "That value is already taken",
        errors: isProd ? null : { fields: err.meta?.target ?? null },
      });
    }
    if (err.code === "P2025") {
      return res.status(404).json({ status: "error", message: "Record not found" });
    }
    if (err.code === "P2003") {
      return res.status(409).json({ status: "error", message: "Referenced record is in use" });
    }
  }

  // Multer surfaces file-upload errors with a `code` string. Translate the
  // common ones to user-actionable 4xx responses instead of 500.
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: string }).code;
    if (code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ status: "error", message: "File too large (max 10MB)" });
    }
    if (code === "LIMIT_FILE_COUNT" || code === "LIMIT_UNEXPECTED_FILE") {
      return res.status(400).json({ status: "error", message: "Invalid upload" });
    }
  }

  // Log the real error server-side, but return a generic message to the client.
  // eslint-disable-next-line no-console
  console.error("[UNHANDLED]", err);
  res.status(500).json({
    status: "error",
    message: "Internal server error",
    errors: isProd ? null : String(err),
  });
};
