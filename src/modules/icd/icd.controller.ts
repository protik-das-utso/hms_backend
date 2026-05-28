import { Request, Response } from "express";
import { prisma } from "../../config/db";
import { ok } from "../../utils/apiResponse";

export const search = async (req: Request, res: Response) => {
  const q = (req.query.q as string | undefined)?.trim();
  if (!q || q.length < 2) {
    return ok(res, []);
  }
  const rows = await prisma.icdCode.findMany({
    where: {
      isActive: true,
      OR: [
        { code: { contains: q, mode: "insensitive" } },
        { term: { contains: q, mode: "insensitive" } },
      ],
    },
    orderBy: [{ code: "asc" }],
    take: 30,
  });
  ok(res, rows);
};
