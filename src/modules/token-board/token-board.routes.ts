import { Router } from "express";
import { asyncHandler } from "../../utils/asyncHandler";
import * as ctrl from "./token-board.controller";

// Public — no auth. Mounted at /public/token-board in modules/index.ts.
export const tokenBoardRouter = Router();
tokenBoardRouter.get("/", asyncHandler(ctrl.board));
