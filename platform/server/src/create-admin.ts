/** Tạo tài khoản admin: ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run create-admin  (đăng nhập lần đầu phải bật 2FA) */
import argon2 from "argon2";
import { loadConfig } from "./config.js";
import { createPgDb } from "./db/db.js";

const email = (process.env.ADMIN_EMAIL || "").toLowerCase();
const password = process.env.ADMIN_PASSWORD || "";
if (!email || password.length < 14) throw new Error("Cần ADMIN_EMAIL và ADMIN_PASSWORD (tối thiểu 14 ký tự)");
const db = createPgDb(loadConfig().databaseUrl);
const hash = await argon2.hash(password, { type: argon2.argon2id });
await db.tx({ system: true }, (q) =>
  q.query("INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'admin') ON CONFLICT (email) DO NOTHING", [email, hash])
);
console.log(`Đã tạo admin ${email}. Đăng nhập rồi bật 2FA ngay.`);
await db.close();
