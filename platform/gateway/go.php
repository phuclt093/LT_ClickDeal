<?php
/**
 * ClickDeal Gateway — bản PHP (cho affiliate có hosting/WordPress).
 * Đặt file này lên hosting của bạn, vd: https://trang-cua-ban.vn/clickdeal/go.php
 * Địa chỉ khai báo trong ClickDeal: https://trang-cua-ban.vn/clickdeal/go.php?url={url}&sub={sub}&click={click}
 *
 * Khóa đọc từ biến môi trường (khuyên dùng). Nếu hosting không hỗ trợ, điền trực tiếp vào 2 dòng dưới
 * và ĐẢM BẢO file không bị tải về dạng văn bản (PHP phải chạy được).
 */
$AT_ACCESS_KEY  = getenv('AT_ACCESS_KEY')  ?: '';   // khóa API AccessTrade của bạn
$AT_CAMPAIGN_ID = getenv('AT_CAMPAIGN_ID') ?: '';   // campaign Shopee trên AccessTrade

header('Cache-Control: no-store');
header('Referrer-Policy: no-referrer');

function cd_fail($code, $msg) { http_response_code($code); header('Content-Type: text/plain; charset=utf-8'); exit($msg); }
function cd_go($to, $fallback = false) { if ($fallback) header('X-ClickDeal-Fallback: 1'); header('Location: ' . $to, true, 302); exit; }

function cd_product_path($u) {
  $p = parse_url($u, PHP_URL_PATH) ?: '';
  if (preg_match('/-i\.(\d+)\.(\d+)/', $p, $m) || preg_match('#^/product/(\d+)/(\d+)#', $p, $m)) {
    return "https://shopee.vn/product/{$m[1]}/{$m[2]}";
  }
  return null;
}

/** Chỉ nhận link Shopee; link rút gọn mở theo redirect thủ công, kiểm tra host từng bước. */
function cd_normalize($raw) {
  $u = $raw;
  for ($hop = 0; $hop < 4; $hop++) {
    $scheme = strtolower((string) parse_url($u, PHP_URL_SCHEME));
    $host = strtolower((string) parse_url($u, PHP_URL_HOST));
    if (!in_array($scheme, ['http', 'https'], true)) return null;
    if (preg_match('/^(shopee\.vn|www\.shopee\.vn|m\.shopee\.vn)$/', $host)) return cd_product_path($u);
    if (!preg_match('/^(s\.shopee\.vn|shope\.ee|shp\.ee|vn\.shp\.ee|[a-z0-9-]+\.shp\.ee)$/', $host)) return null;
    $ch = curl_init($u);
    curl_setopt_array($ch, [CURLOPT_NOBODY => true, CURLOPT_FOLLOWLOCATION => false, CURLOPT_RETURNTRANSFER => true,
      CURLOPT_HEADER => true, CURLOPT_TIMEOUT => 4, CURLOPT_PROTOCOLS => CURLPROTO_HTTPS | CURLPROTO_HTTP]);
    $resp = curl_exec($ch);
    curl_close($ch);
    if (!$resp || !preg_match('/^location:\s*(\S+)/mi', $resp, $m)) return null;
    $loc = $m[1];
    if (strpos($loc, '//') === 0) $loc = 'https:' . $loc;
    elseif ($loc[0] === '/') $loc = 'https://' . $host . $loc;
    $u = $loc;
  }
  return null;
}

if (!$AT_ACCESS_KEY || !$AT_CAMPAIGN_ID) cd_fail(500, 'Cổng chưa cài AT_ACCESS_KEY / AT_CAMPAIGN_ID');
$raw = isset($_GET['url']) ? (string) $_GET['url'] : '';
$sub = isset($_GET['sub']) ? (string) $_GET['sub'] : '';
$click = isset($_GET['click']) ? (string) $_GET['click'] : '';
foreach ([$sub, $click] as $v) if ($v !== '' && !preg_match('/^[A-Za-z0-9_-]{1,64}$/', $v)) cd_fail(400, 'Tham số không hợp lệ');

$product = cd_normalize($raw);
if (!$product) cd_fail(400, 'Chỉ hỗ trợ link sản phẩm Shopee');

$body = ['campaign_id' => $AT_CAMPAIGN_ID, 'urls' => [$product], 'url_enc' => true, 'utm_source' => 'clickdeal'];
if ($sub !== '') $body['utm_content'] = $sub;
if ($click !== '') $body['sub1'] = $click;
$ch = curl_init('https://api.accesstrade.vn/v1/product_link/create');
curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 8,
  CURLOPT_HTTPHEADER => ['Authorization: Token ' . $AT_ACCESS_KEY, 'Content-Type: application/json'],
  CURLOPT_POSTFIELDS => json_encode($body)]);
$res = curl_exec($ch);
$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

$j = $status === 200 ? json_decode((string) $res, true) : null;
$link = $j['data']['success_link'][0]['short_link'] ?? ($j['data']['success_link'][0]['aff_link'] ?? null);
if (is_string($link) && preg_match('#^https://#i', $link)) cd_go($link);
cd_go($product, true); // lỗi thì vẫn cho khách mở sản phẩm (không hoàn tiền)
