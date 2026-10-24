-- Cách kết nối ưu tiên: cổng nhận link trên trang của affiliate (không cần ClickDeal giữ khóa API)
ALTER TABLE affiliates
  ADD COLUMN link_mode text NOT NULL DEFAULT 'gateway' CHECK (link_mode IN ('gateway', 'api')),
  ADD COLUMN gateway_template text,
  ADD COLUMN gateway_verified_at timestamptz;
COMMENT ON COLUMN affiliates.gateway_template IS 'vd https://trang-cua-ho/go?url={url}&sub={sub}';
