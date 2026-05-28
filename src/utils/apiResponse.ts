import { Response } from "express";

export interface ApiSuccess<T> {
  status: "success";
  message: string;
  data: T;
  pagination?: PaginationMeta;
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export const ok = <T>(res: Response, data: T, message = "OK", pagination?: PaginationMeta) => {
  const body: ApiSuccess<T> = { status: "success", message, data };
  if (pagination) body.pagination = pagination;
  res.json(body);
};

export const created = <T>(res: Response, data: T, message = "Created") => {
  res.status(201).json({ status: "success", message, data });
};

export const paginate = (page: number, pageSize: number, total: number): PaginationMeta => ({
  page,
  pageSize,
  total,
  totalPages: Math.max(1, Math.ceil(total / pageSize)),
});
