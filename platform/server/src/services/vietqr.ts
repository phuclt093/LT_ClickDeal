/**
 * Tạo mã VietQR (chuẩn EMVCo/NAPAS) ngay trên server, không gửi số tài khoản của khách cho bên thứ ba.
 * App ngân hàng quét mã sẽ điền sẵn ngân hàng, số tài khoản, số tiền và nội dung chuyển khoản.
 */
import QRCode from "qrcode";

/** Mã BIN ngân hàng theo NAPAS. Ngân hàng không có trong danh sách: vẫn lưu được, chỉ không tạo được QR. */
export const BANKS: { bin: string; name: string }[] = [
  { bin: "970436", name: "Vietcombank" },
  { bin: "970415", name: "VietinBank" },
  { bin: "970418", name: "BIDV" },
  { bin: "970405", name: "Agribank" },
  { bin: "970407", name: "Techcombank" },
  { bin: "970422", name: "MB Bank" },
  { bin: "970416", name: "ACB" },
  { bin: "970432", name: "VPBank" },
  { bin: "970423", name: "TPBank" },
  { bin: "970403", name: "Sacombank" },
  { bin: "970437", name: "HDBank" },
  { bin: "970441", name: "VIB" },
  { bin: "970443", name: "SHB" },
  { bin: "970431", name: "Eximbank" },
  { bin: "970426", name: "MSB" },
  { bin: "970448", name: "OCB" },
  { bin: "970440", name: "SeABank" },
  { bin: "970449", name: "LPBank" },
  { bin: "970428", name: "Nam A Bank" },
  { bin: "970409", name: "Bac A Bank" },
  { bin: "970425", name: "ABBANK" },
  { bin: "970427", name: "VietABank" },
  { bin: "970438", name: "BaoViet Bank" },
  { bin: "970412", name: "PVcomBank" },
  { bin: "970452", name: "KienlongBank" },
  { bin: "970419", name: "NCB" },
  { bin: "970400", name: "Saigonbank" },
  { bin: "970433", name: "VietBank" },
  { bin: "970430", name: "PGBank" },
  { bin: "970454", name: "BVBank (Viet Capital)" },
  { bin: "546034", name: "CAKE by VPBank" },
  { bin: "546035", name: "Ubank by VPBank" }
];

export function bankName(bin: string) {
  return BANKS.find((b) => b.bin === bin)?.name ?? null;
}

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) theo yêu cầu của EMVCo. */
export function crc16(s: string): string {
  let crc = 0xffff;
  for (const byte of Buffer.from(s, "utf8")) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

const tlv = (id: string, value: string) => id + String(value.length).padStart(2, "0") + value;

/** Nội dung chuyển khoản chỉ gồm chữ không dấu, số và khoảng trắng (app ngân hàng nào cũng nhận). */
export function cleanTransferNote(s: string) {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 25);
}

export function vietQrPayload(p: { bin: string; account: string; amount: number; note: string }) {
  if (!/^\d{6}$/.test(p.bin)) throw new Error("BIN không hợp lệ");
  if (!/^[0-9A-Za-z]{4,19}$/.test(p.account)) throw new Error("Số tài khoản không hợp lệ");
  const amount = Math.round(p.amount);
  const beneficiary = tlv("00", p.bin) + tlv("01", p.account);
  const merchant = tlv("00", "A000000727") + tlv("01", beneficiary) + tlv("02", "QRIBFTTA");
  let s =
    tlv("00", "01") +
    tlv("01", amount > 0 ? "12" : "11") +
    tlv("38", merchant) +
    tlv("53", "704") +
    (amount > 0 ? tlv("54", String(amount)) : "") +
    tlv("58", "VN");
  const note = cleanTransferNote(p.note);
  if (note) s += tlv("62", tlv("08", note));
  s += "6304";
  return s + crc16(s);
}

export async function vietQrSvgDataUrl(payload: string) {
  const svg = await QRCode.toString(payload, { type: "svg", margin: 1, width: 240, errorCorrectionLevel: "M" });
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}
