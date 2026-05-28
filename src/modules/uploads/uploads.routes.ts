import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { authenticate } from "../../middleware/auth";
import { asyncHandler } from "../../utils/asyncHandler";
import { ok } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import { env } from "../../config/env";

const ALLOWED_FOLDERS = new Set(["users", "patients", "referrers", "tenants", "misc", "reports", "support"]);
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

// Map MIME to a single canonical extension. Filename never trusts the
// user-supplied originalname — that path could carry traversal sequences,
// double-extensions like `evil.png.exe`, or tricky unicode.
const MIME_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

const safeFolder = (raw: unknown): string => {
  const s = String(raw ?? "").toLowerCase();
  return ALLOWED_FOLDERS.has(s) ? s : "misc";
};

const uploadsRoot = path.resolve(env.storageDir, "uploads");
for (const sub of ALLOWED_FOLDERS) {
  fs.mkdirSync(path.join(uploadsRoot, sub), { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    cb(null, path.join(uploadsRoot, safeFolder(String(req.params.folder))));
  },
  filename: (_req, file, cb) => {
    const ext = MIME_EXT[file.mimetype] ?? ".bin";
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`);
  },
});

const upload = multer({
  storage,
  // 10 MB cap — generous for support-ticket screenshots and patient photos
  // alike. Multer aborts the request before reading the full body if exceeded.
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(new ApiError(400, "Only JPG/PNG/WEBP/GIF images allowed"));
    }
    cb(null, true);
  },
});

export const uploadsRouter = Router();
uploadsRouter.use(authenticate);

uploadsRouter.post(
  "/image/:folder",
  (req, _res, next) => {
    // Reject obviously bad folder names early so multer isn't even invoked.
    if (!ALLOWED_FOLDERS.has(String(req.params.folder ?? "").toLowerCase())) {
      return next(new ApiError(400, "Invalid upload folder"));
    }
    next();
  },
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) throw ApiError.badRequest("No file uploaded");
    const folder = safeFolder(String(req.params.folder));
    const url = `/uploads/${folder}/${req.file.filename}`;
    ok(res, { url, filename: req.file.filename, size: req.file.size }, "Uploaded");
  })
);

