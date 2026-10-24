import type { AppConfig } from "../config.js";
import type { Db, Queryable } from "../db/db.js";
import type { SecretBox } from "../security/crypto.js";
import type { Network, NetworkConnector } from "../connectors/types.js";

export interface Deps {
  config: AppConfig;
  db: Db;
  box: SecretBox;
  connectors: Record<Network, NetworkConnector>;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}

export class AppError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export async function audit(
  q: Queryable,
  e: { affiliateId?: string | null; actorUserId?: string | null; action: string; target?: string; ip?: string }
) {
  await q.query(
    "INSERT INTO audit_logs(affiliate_id, actor_user_id, action, target, ip) VALUES ($1, $2, $3, $4, $5)",
    [e.affiliateId ?? null, e.actorUserId ?? null, e.action, e.target ?? null, e.ip ?? null]
  );
}
