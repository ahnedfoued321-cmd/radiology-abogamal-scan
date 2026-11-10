import { encodeTlvBase64, type TlvField } from "./tlv.js";
import { buildUblInvoice, type UblInvoice } from "./ubl.js";
import { INITIAL_PIH, invoiceHash, publicKeyDer, signInvoiceHash } from "./crypto.js";

export * from "./tlv.js";
export * from "./ubl.js";
export * from "./crypto.js";

/** Per-device (EGS unit / POS terminal) e-invoice chain state. ZATCA requires ICV + PIH continuity per device. */
export interface DeviceChainState {
  icv: number; // last used invoice counter value (0 = none issued yet)
  lastHash: string; // hash of the last issued invoice (INITIAL_PIH when none)
}

export const NEW_DEVICE_CHAIN: DeviceChainState = { icv: 0, lastHash: INITIAL_PIH };

export interface Phase1QrInput {
  sellerName: string;
  vatNumber: string;
  timestamp: string; // ISO 8601, e.g. 2026-11-10T22:15:00Z
  total: string; // with VAT
  vatTotal: string;
}

export function buildPhase1Qr(q: Phase1QrInput): string {
  return encodeTlvBase64(phase1Fields(q));
}

function phase1Fields(q: Phase1QrInput): TlvField[] {
  if (!/^3\d{13}3$/.test(q.vatNumber)) {
    throw new Error("KSA VAT number must be 15 digits starting and ending with 3");
  }
  return [
    { tag: 1, value: q.sellerName },
    { tag: 2, value: q.vatNumber },
    { tag: 3, value: q.timestamp },
    { tag: 4, value: q.total },
    { tag: 5, value: q.vatTotal },
  ];
}

export interface SignedInvoiceResult {
  icv: number;
  pih: string;
  hash: string;
  signature: string;
  qr: string;
  xml: string;
  nextChain: DeviceChainState;
}

export interface IssueInput extends Omit<UblInvoice, "icv" | "pih"> {
  timestamp: string;
}

/**
 * Issue a signed e-invoice for a device: assigns the next ICV, links PIH, hashes, signs,
 * builds the Phase 2 QR and returns the new chain state to persist atomically with the invoice.
 */
export function issueInvoice(
  input: IssueInput,
  chain: DeviceChainState,
  keys: { privateKeyPem: string; publicKeyPem: string; certificateSignature?: Uint8Array },
): SignedInvoiceResult {
  const icv = chain.icv + 1;
  const pih = chain.lastHash;
  const { timestamp, ...ubl } = input;
  const doc = buildUblInvoice({ ...ubl, icv, pih });
  const hash = invoiceHash(doc.hashable);
  const signature = signInvoiceHash(hash, keys.privateKeyPem);

  const fields: TlvField[] = [
    ...phase1Fields({
      sellerName: ubl.seller.name,
      vatNumber: ubl.seller.vatNumber ?? "",
      timestamp,
      total: ubl.totals.taxInclusive,
      vatTotal: ubl.totals.taxTotal,
    }),
    { tag: 6, value: hash },
    { tag: 7, value: signature },
    { tag: 8, value: publicKeyDer(keys.publicKeyPem) },
  ];
  if (ubl.kind === "SIMPLIFIED" && keys.certificateSignature) {
    fields.push({ tag: 9, value: keys.certificateSignature });
  }
  const qr = encodeTlvBase64(fields);
  return {
    icv,
    pih,
    hash,
    signature,
    qr,
    xml: doc.withQr(qr),
    nextChain: { icv, lastHash: hash },
  };
}
