/**
 * ZATCA QR code TLV (Tag-Length-Value) encoding.
 *
 * Phase 1 tags (all invoices):
 *   1 Seller name · 2 VAT registration number · 3 Timestamp (ISO 8601)
 *   4 Invoice total (with VAT) · 5 VAT total
 * Phase 2 adds:
 *   6 Invoice hash (base64 text) · 7 ECDSA signature (base64 text)
 *   8 ECDSA public key (raw bytes) · 9 Certificate signature by ZATCA CA (raw bytes, simplified invoices)
 *
 * Each field: 1 byte tag, 1 byte length, value bytes. The whole buffer is base64-encoded.
 */
export type TlvValue = string | Uint8Array;

export interface TlvField {
  tag: number;
  value: TlvValue;
}

export function encodeTlv(fields: TlvField[]): Buffer {
  const parts: Buffer[] = [];
  for (const { tag, value } of fields) {
    if (!Number.isInteger(tag) || tag < 1 || tag > 255) throw new Error(`Invalid TLV tag ${tag}`);
    const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
    if (bytes.length > 255) {
      throw new Error(`TLV value for tag ${tag} is ${bytes.length} bytes; max 255`);
    }
    parts.push(Buffer.from([tag, bytes.length]), bytes);
  }
  return Buffer.concat(parts);
}

export function encodeTlvBase64(fields: TlvField[]): string {
  return encodeTlv(fields).toString("base64");
}

export function decodeTlv(input: Buffer | string): Map<number, Buffer> {
  const buf = typeof input === "string" ? Buffer.from(input, "base64") : input;
  const out = new Map<number, Buffer>();
  let i = 0;
  while (i < buf.length) {
    const tag = buf[i];
    const len = buf[i + 1];
    if (tag === undefined || len === undefined || i + 2 + len > buf.length) {
      throw new Error("Malformed TLV data");
    }
    out.set(tag, buf.subarray(i + 2, i + 2 + len));
    i += 2 + len;
  }
  return out;
}
