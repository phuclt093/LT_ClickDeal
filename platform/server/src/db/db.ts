/**
 * Lớp truy cập DB. Mọi truy vấn chạy trong transaction với:
 *   SET LOCAL ROLE clickdeal_app  → không phải chủ bảng nên RLS luôn có hiệu lực
 *   app.affiliate_id               → affiliate đang thao tác (chỉ thấy dữ liệu của mình)
 *   app.bypass = on                → chỉ cho tác vụ hệ thống (tra token, worker, đăng nhập)
 */
import pg from "pg";

export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export type DbContext = { affiliateId: string } | { system: true };

export interface Db {
  /** Chạy fn trong 1 transaction với ngữ cảnh phân quyền. */
  tx<T>(ctx: DbContext, fn: (q: Queryable) => Promise<T>): Promise<T>;
  /** Chỉ dùng cho migration (chạy với quyền chủ sở hữu, không qua RLS). */
  ownerQuery<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Chạy nhiều câu lệnh SQL (file migration) với quyền chủ sở hữu. */
  ownerExec(sql: string): Promise<void>;
  close(): Promise<void>;
}

async function applyContext(q: Queryable, ctx: DbContext) {
  await q.query("SET LOCAL ROLE clickdeal_app");
  if ("system" in ctx) {
    await q.query("SELECT set_config('app.bypass', 'on', true)");
  } else {
    if (!/^[0-9a-f-]{36}$/i.test(ctx.affiliateId)) throw new Error("affiliateId không hợp lệ");
    await q.query("SELECT set_config('app.affiliate_id', $1, true)", [ctx.affiliateId]);
  }
}

export function createPgDb(databaseUrl: string): Db {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  return {
    async tx(ctx, fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await applyContext(client, ctx);
        const r = await fn(client);
        await client.query("COMMIT");
        return r;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    async ownerQuery(sql, params) {
      return (await pool.query(sql, params as any[])).rows;
    },
    async ownerExec(sql) {
      await pool.query(sql);
    },
    close: () => pool.end()
  };
}

/** PGlite (Postgres chạy trong tiến trình) — dùng cho test và chạy thử không cần cài Postgres. */
export async function createPgliteDb(): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  // PGlite chạy 1 kết nối → xếp hàng các transaction
  let chain: Promise<unknown> = Promise.resolve();
  return {
    tx(ctx, fn) {
      const run = chain.then(() =>
        db.transaction(async (t) => {
          const q: Queryable = { query: (s, p) => t.query(s, p as any[]) as any };
          await applyContext(q, ctx);
          return fn(q);
        })
      );
      chain = run.catch(() => {});
      return run;
    },
    async ownerQuery(sql, params) {
      return ((await db.query(sql, params as any[])) as any).rows;
    },
    async ownerExec(sql) {
      await db.exec(sql);
    },
    close: () => db.close()
  };
}
