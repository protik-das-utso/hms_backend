import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import path from "path";
import { env, isProd } from "./config/env";
import { notFound, errorHandler } from "./middleware/error";
import { apiLimiter } from "./middleware/rateLimit";
import { router as apiRouter } from "./modules";

export const createApp = () => {
  const app = express();

  // Honor X-Forwarded-For from a single trusted proxy hop (Nginx/Cloudflare).
  // Required for express-rate-limit and req.ip to see the real client IP in
  // production. Set to a more specific value (number of hops or specific IPs)
  // once your reverse-proxy topology is finalized.
  app.set("trust proxy", 1);

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: "cross-origin" },
    })
  );
  app.use(
    cors({
      origin: env.corsOrigin,
      credentials: true,
    })
  );
  app.use(express.json({ limit: "5mb" }));
  app.use(express.urlencoded({ extended: true }));
  if (!isProd) app.use(morgan("dev"));

  // Static uploads
  app.use(
    "/uploads",
    express.static(path.resolve(env.storageDir, "uploads"), {
      maxAge: "1d",
      fallthrough: false,
      // Force download for non-image-safe types (defense-in-depth even though
      // upload filter only allows raster images). Prevents an SVG smuggled in
      // as image/* from executing inline scripts when later viewed.
      setHeaders: (res, filePath) => {
        if (filePath.toLowerCase().endsWith(".svg")) {
          res.setHeader("Content-Disposition", "attachment");
        }
        res.setHeader("X-Content-Type-Options", "nosniff");
      },
    })
  );

  // Health
  app.get("/health", (_req, res) =>
    res.json({ status: "ok", service: env.appName, time: new Date().toISOString() })
  );

  // Global rate-limit on every API call (per-IP). Auth endpoints layer a
  // tighter per-IP+phone limiter on top in their respective routers.
  app.use(env.apiPrefix, apiLimiter, apiRouter);

  // 404 + errors
  app.use(notFound);
  app.use(errorHandler);

  return app;
};
