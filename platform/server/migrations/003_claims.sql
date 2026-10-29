-- ClickDeal 0.2: người mua có tài khoản, báo đơn kèm bằng chứng, trao đổi kiểu khiếu nại P2P,
-- affiliate trả tiền bằng VietQR. ClickDeal không phân xử: mọi trao đổi được lưu nguyên vẹn (chỉ ghi thêm).

-- ---------- Tài khoản: thêm vai trò người mua, đăng nhập bằng số điện thoại ----------
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'affiliate', 'buyer'));
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users
  ADD COLUMN phone             text UNIQUE CHECK (phone ~ '^0[0-9]{9,10}$'),
  ADD COLUMN display_name      text,
  ADD COLUMN terms_version     text,
  ADD COLUMN terms_accepted_at timestamptz,
  ADD COLUMN disabled_at       timestamptz,
  ADD CONSTRAINT users_login_check CHECK (email IS NOT NULL OR phone IS NOT NULL);

-- Khách gắn với tài khoản người mua. token_hash giờ là "mã kết nối" tùy chọn cho tiện ích trình duyệt.
ALTER TABLE customers
  ADD COLUMN user_id    uuid UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN bank_enc   text,          -- {bin, account, holder} đã mã hóa
  ADD COLUMN bank_label text;          -- vd "Vietcombank ••• 6789" (hiển thị, không bí mật)
ALTER TABLE customers ALTER COLUMN token_hash DROP NOT NULL;

ALTER TABLE affiliates
  ADD COLUMN remind_after_days  int NOT NULL DEFAULT 14 CHECK (remind_after_days BETWEEN 3 AND 60),
  ADD COLUMN order_sync_enabled boolean NOT NULL DEFAULT false;

-- ---------- Bằng chứng (ảnh): mã hóa, không sửa/xóa được qua ứng dụng ----------
CREATE TABLE attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id uuid NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  customer_id  uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  uploader     text NOT NULL CHECK (uploader IN ('buyer', 'affiliate')),
  mime         text NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  size         int  NOT NULL CHECK (size > 0),
  sha256       text NOT NULL,
  data_enc     text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_customer_idx ON attachments(customer_id);

ALTER TABLE payouts
  ADD COLUMN receipt_id uuid REFERENCES attachments(id),
  ADD COLUMN method     text;

-- ---------- Báo đơn ----------
CREATE TABLE claims (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  no              bigint GENERATED ALWAYS AS IDENTITY UNIQUE,   -- số hiển thị: #1024
  affiliate_id    uuid NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  customer_id     uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  link_id         uuid REFERENCES links(id) ON DELETE SET NULL,
  order_code      text NOT NULL CHECK (order_code ~ '^[A-Z0-9]{6,30}$'),
  order_amount    numeric(14,2) CHECK (order_amount >= 0),
  ordered_on      date,
  product_name    text,
  -- submitted: chờ affiliate xem | accepted: đơn hợp lệ, chờ đơn hoàn tất để trả | rejected: bị từ chối
  -- paid: affiliate báo đã chuyển tiền | completed: khách xác nhận đã nhận (hoặc tự hoàn tất sau 7 ngày)
  -- cancelled: khách tự hủy
  status          text NOT NULL DEFAULT 'submitted'
                  CHECK (status IN ('submitted', 'accepted', 'rejected', 'paid', 'completed', 'cancelled')),
  commission      numeric(14,2) CHECK (commission >= 0),       -- hoa hồng affiliate nhận (theo AccessTrade)
  cashback        numeric(14,2) CHECK (cashback >= 0),         -- tiền hoàn cho khách
  reject_reason   text,
  disputed        boolean NOT NULL DEFAULT false,
  disputed_at     timestamptz,
  remind_at       timestamptz,                                 -- từ lúc này nhắc affiliate tự kiểm tra
  payout_id       uuid REFERENCES payouts(id) ON DELETE SET NULL,
  submitted_at    timestamptz NOT NULL DEFAULT now(),
  accepted_at     timestamptz,
  paid_at         timestamptz,
  completed_at    timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (affiliate_id, order_code)
);
CREATE INDEX claims_aff_status_idx ON claims(affiliate_id, status);
CREATE INDEX claims_customer_idx ON claims(customer_id, submitted_at DESC);

-- Dòng thời gian của mỗi đơn: tin nhắn, ảnh, đổi trạng thái. Chỉ ghi thêm.
CREATE TABLE claim_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  claim_id      uuid NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  affiliate_id  uuid NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  actor         text NOT NULL CHECK (actor IN ('buyer', 'affiliate', 'system')),
  kind          text NOT NULL CHECK (kind IN ('message', 'status')),
  body          text,
  attachment_id uuid REFERENCES attachments(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX claim_events_claim_idx ON claim_events(claim_id, id);

-- ---------- Row Level Security ----------
ALTER TABLE attachments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE claims       ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON attachments  USING (cd_bypass() OR affiliate_id = cd_aff()) WITH CHECK (cd_bypass() OR affiliate_id = cd_aff());
CREATE POLICY tenant ON claims       USING (cd_bypass() OR affiliate_id = cd_aff()) WITH CHECK (cd_bypass() OR affiliate_id = cd_aff());
CREATE POLICY tenant ON claim_events USING (cd_bypass() OR affiliate_id = cd_aff()) WITH CHECK (cd_bypass() OR affiliate_id = cd_aff());

GRANT SELECT, INSERT, UPDATE ON claims TO clickdeal_app;
-- bằng chứng và trao đổi: chỉ đọc và ghi thêm, không sửa/xóa được (phục vụ cung cấp trung thực khi có yêu cầu)
GRANT SELECT, INSERT ON attachments, claim_events TO clickdeal_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO clickdeal_app;
