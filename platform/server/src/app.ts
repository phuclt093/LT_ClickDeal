import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ZodError } from "zod";
import { NetworkError } from "./connectors/types.js";
import { BadUrlError } from "./services/shopee-url.js";
import { AppError, type Deps } from "./services/deps.js";
import { authRoutes } from "./routes/auth.js";
import { extRoutes } from "./routes/ext.js";
import { affRoutes } from "./routes/aff.js";
import { adminRoutes } from "./routes/admin.js";
import { baseUrl } from "./routes/util.js";

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");

export async function buildApp(deps: Deps, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: true,
    bodyLimit: 64 * 1024,
    logger: opts.logger
      ? {
          // không bao giờ ghi bí mật vào log
          redact: {
            paths: [
              "req.headers.authorization",
              "req.headers.cookie",
              "res.headers['set-cookie']",
              "body.password",
              "body.accessKey",
              "body.secret",
              "body.totp",
              "body.contact"
            ],
            censor: "[ẩn]"
          }
        }
      : false
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        baseUri: ["'none'"],
        objectSrc: ["'none'"]
      }
    },
    crossOriginEmbedderPolicy: false,
    hsts: { maxAge: 31536000, includeSubDomains: true }
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 300, timeWindow: "1 minute" });

  // Chống CSRF cho các API dùng cookie: yêu cầu JSON + Origin đúng tên miền
  app.addHook("onRequest", async (req) => {
    const m = req.method;
    if (m === "GET" || m === "HEAD" || m === "OPTIONS") return;
    if (!req.url.startsWith("/v1/auth") && !req.url.startsWith("/v1/aff") && !req.url.startsWith("/v1/admin")) return;
    const origin = req.headers.origin;
    if (origin && origin !== baseUrl(deps, req)) throw new AppError("Nguồn yêu cầu không hợp lệ", 403);
    const ct = String(req.headers["content-type"] || "");
    if (m !== "DELETE" && !ct.startsWith("application/json") && req.url !== "/v1/auth/logout") {
      throw new AppError("Yêu cầu phải là JSON", 415);
    }
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: err.issues[0]?.message || "Dữ liệu không hợp lệ" });
    }
    if (err instanceof AppError || err instanceof NetworkError) return reply.status(err.status).send({ error: err.message });
    if (err instanceof BadUrlError) return reply.status(400).send({ error: err.message });
    if (err.statusCode === 429) return reply.status(429).send({ error: "Bạn thao tác quá nhanh, thử lại sau ít phút" });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message });
    req.log?.error(err);
    return reply.status(500).send({ error: "Lỗi hệ thống, vui lòng thử lại" });
  });

  app.get("/healthz", async () => ({ ok: true }));

  authRoutes(app, deps);
  extRoutes(app, deps);
  affRoutes(app, deps);
  adminRoutes(app, deps);

  // PWA cho người mua: trang chủ, link mời /j/<mã>, nhận link chia sẻ /share
  await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: "/", index: ["index.html"], redirect: true });
  app.get("/j/:code", (req, reply) => reply.type("text/html").sendFile("join.html"));
  app.get("/share", (req, reply) => reply.type("text/html").sendFile("share.html"));

  return app;
}
