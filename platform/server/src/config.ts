/**
 * Cấu hình đọc từ biến môi trường. Không bao giờ hard-code bí mật trong code.
 */
export interface AppConfig {
  port: number;
  databaseUrl: string;
  /** Khóa chính 32 byte (base64) dùng bọc khóa dữ liệu. Production: thay bằng KMS. */
  masterKey: Buffer;
  /** Địa chỉ công khai, vd https://clickdeal.vn. Để trống = tự nhận theo request (tunnel tạm đổi địa chỉ). */
  publicBaseUrl: string;
  cookieSecure: boolean;
  autoApproveAffiliates: boolean;
  /** Mã affiliate nhận người mua tự đăng ký không có mã mời (để trống = bắt buộc có mã mời). */
  defaultInviteCode: string;
  accesstradeBaseUrl: string;
  shopeeGraphqlUrl: string;
  syncIntervalMs: number;
  /** Khoảng cách tối thiểu giữa 2 lần gọi API đơn hàng với cùng 1 khóa (AccessTrade: 10 lần/phút). */
  networkMinIntervalMs: number;
}

function bool(v: string | undefined, d: boolean) {
  if (v === undefined || v === "") return d;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const mk = env.MASTER_KEY || "";
  const masterKey = Buffer.from(mk, "base64");
  if (masterKey.length !== 32) {
    throw new Error("MASTER_KEY phải là 32 byte mã hóa base64 (tạo bằng: openssl rand -base64 32)");
  }
  return {
    port: Number(env.PORT || 8080),
    databaseUrl: env.DATABASE_URL || "",
    masterKey,
    publicBaseUrl: (env.PUBLIC_BASE_URL || "").replace(/\/$/, ""),
    cookieSecure: bool(env.COOKIE_SECURE, true),
    autoApproveAffiliates: bool(env.AUTO_APPROVE_AFFILIATES, false),
    defaultInviteCode: (env.DEFAULT_INVITE_CODE || "").trim().toUpperCase(),
    accesstradeBaseUrl: (env.ACCESSTRADE_BASE_URL || "https://api.accesstrade.vn").replace(/\/$/, ""),
    shopeeGraphqlUrl: env.SHOPEE_GRAPHQL_URL || "https://open-api.affiliate.shopee.vn/graphql",
    syncIntervalMs: Number(env.SYNC_INTERVAL_MS || 20 * 60 * 1000),
    networkMinIntervalMs: Number(env.NETWORK_MIN_INTERVAL_MS ?? 6500)
  };
}
