import type { FastifyRequest } from "fastify";
import type { Deps } from "../services/deps.js";

/** Địa chỉ gốc của trang: lấy từ cấu hình, nếu trống thì theo request (qua Cloudflare Tunnel). */
export function baseUrl(deps: Deps, req: FastifyRequest): string {
  return deps.config.publicBaseUrl || `${req.protocol}://${req.host}`;
}
