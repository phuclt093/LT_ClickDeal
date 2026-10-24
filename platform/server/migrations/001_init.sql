-- ClickDeal Platform — lược đồ ban đầu
-- Nguyên tắc: mọi bảng nghiệp vụ có affiliate_id + Row Level Security (RLS).
-- Ứng dụng luôn chạy với role clickdeal_app (KHÔNG phải chủ bảng) nên RLS luôn có hiệu lực.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clickdeal_app') THEN
    CREATE ROLE clickdeal_app NOLOGIN;
  END IF;
END $$;

-- Ngữ cảnh phiên: affiliate đang thao tác, hoặc chế độ hệ thống (worker, tra token)
CREATE OR REPLACE FUNCTION cd_aff() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.affiliate_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION cd_bypass() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT coalesce(current_setting('app.bypass', true), '') = 'on' $$;

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash   text NOT NULL,
  role            text NOT NULL CHECK (role IN ('admin', 'affiliate')),
  totp_secret_enc text,
  totp_enabled    boolean NOT NULL DEFAULT false,
  failed_logins   int NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  mfa_passed  boolean NOT NULL DEFAULT false,
  expires_at  timestamptz NOT NULL,
  ip          text,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE affiliates (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  code                  text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{3,20}$'),
  display_name          text NOT NULL,
  default_cashback_rate numeric(5,2) NOT NULL DEFAULT 50 CHECK (default_cashback_rate BETWEEN 0 AND 100),
  preferred_network     text NOT NULL DEFAULT 'accesstrade' CHECK (preferred_network IN ('accesstrade', 'shopee')),
  plan                  text NOT NULL DEFAULT 'trial',
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended')),
  last_synced_at        timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE affiliate_credentials (
  affiliate_id  uuid NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  network       text NOT NULL CHECK (network IN ('accesstrade', 'shopee')),
  secret_enc    text NOT NULL,         -- khóa API/Secret đã mã hóa (envelope, AES-256-GCM)
  key_last4     text NOT NULL,
  app_id        text,                  -- Shopee AppId (không bí mật)
  campaign_id   text,                  -- AccessTrade: campaign Shopee
  verified_at   timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (affiliate_id, network)
);

CREATE TABLE customers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id  uuid NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  ref_code      text NOT NULL UNIQUE,  -- gắn vào utm_content để ghép đơn
  nickname      text,
  contact_enc   text,                  -- Zalo/điện thoại, mã hóa
  token_hash    text NOT NULL UNIQUE,  -- token của khách, chỉ lưu SHA-256
  cashback_rate numeric(5,2) CHECK (cashback_rate BETWEEN 0 AND 100),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX customers_affiliate_idx ON customers(affiliate_id);

CREATE TABLE links (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id  uuid NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  customer_id   uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  network       text NOT NULL,
  platform      text NOT NULL DEFAULT 'shopee',
  source        text NOT NULL DEFAULT 'extension' CHECK (source IN ('extension', 'pwa', 'web', 'shortcut', 'bot')),
  product_url   text NOT NULL,
  product_name  text,
  price         text,
  image         text,
  aff_link      text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX links_customer_idx ON links(customer_id, created_at DESC);

CREATE TABLE orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id      uuid NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  customer_id       uuid REFERENCES customers(id) ON DELETE SET NULL,
  network           text NOT NULL,
  network_order_id  text NOT NULL,
  merchant          text,
  billing           numeric(14,2) NOT NULL DEFAULT 0,
  pub_commission    numeric(14,2) NOT NULL DEFAULT 0,
  status            text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  is_confirmed      boolean NOT NULL DEFAULT false,
  ref_code          text,
  sales_time        timestamptz,
  synced_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (affiliate_id, network, network_order_id)
);
CREATE INDEX orders_customer_idx ON orders(customer_id);

CREATE TABLE payouts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id  uuid NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  customer_id   uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  amount        numeric(14,2) NOT NULL CHECK (amount > 0),
  note          text,
  paid_at       timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id            bigserial PRIMARY KEY,
  affiliate_id  uuid,
  actor_user_id uuid,
  action        text NOT NULL,
  target        text,
  ip            text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------- Row Level Security ----------
ALTER TABLE affiliates            ENABLE ROW LEVEL SECURITY;
ALTER TABLE affiliate_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers             ENABLE ROW LEVEL SECURITY;
ALTER TABLE links                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders                ENABLE ROW LEVEL SECURITY;
ALTER TABLE payouts               ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs            ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant ON affiliates            USING (cd_bypass() OR id = cd_aff())           WITH CHECK (cd_bypass() OR id = cd_aff());
CREATE POLICY tenant ON affiliate_credentials USING (cd_bypass() OR affiliate_id = cd_aff()) WITH CHECK (cd_bypass() OR affiliate_id = cd_aff());
CREATE POLICY tenant ON customers             USING (cd_bypass() OR affiliate_id = cd_aff()) WITH CHECK (cd_bypass() OR affiliate_id = cd_aff());
CREATE POLICY tenant ON links                 USING (cd_bypass() OR affiliate_id = cd_aff()) WITH CHECK (cd_bypass() OR affiliate_id = cd_aff());
CREATE POLICY tenant ON orders                USING (cd_bypass() OR affiliate_id = cd_aff()) WITH CHECK (cd_bypass() OR affiliate_id = cd_aff());
CREATE POLICY tenant ON payouts               USING (cd_bypass() OR affiliate_id = cd_aff()) WITH CHECK (cd_bypass() OR affiliate_id = cd_aff());
CREATE POLICY tenant ON audit_logs            USING (cd_bypass() OR affiliate_id = cd_aff()) WITH CHECK (true);

-- ---------- Quyền của role ứng dụng ----------
GRANT USAGE ON SCHEMA public TO clickdeal_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON users, sessions, affiliates, affiliate_credentials,
  customers, links, orders, payouts TO clickdeal_app;
-- Nhật ký thao tác: chỉ ghi thêm, không ai sửa/xóa được qua ứng dụng
GRANT SELECT, INSERT ON audit_logs TO clickdeal_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO clickdeal_app;
