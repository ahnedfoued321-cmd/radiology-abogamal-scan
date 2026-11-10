import { createHash, generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify, KeyObject } from "node:crypto";

/**
 * Initial Previous-Invoice-Hash (PIH) for the first invoice of a device:
 * base64( hex( SHA-256("0") ) ) — as specified by ZATCA.
 */
export const INITIAL_PIH = Buffer.from(createHash("sha256").update("0").digest("hex"), "utf8").toString("base64");

/** Invoice hash = base64( SHA-256( canonical invoice XML without signature/QR/extensions ) ). */
export function invoiceHash(hashableXml: string): string {
  return createHash("sha256").update(hashableXml, "utf8").digest("base64");
}

export interface DeviceKeys {
  privateKeyPem: string;
  publicKeyPem: string;
}

/** Generate an ECDSA secp256k1 key pair (the curve ZATCA uses for EGS units / CSR). */
export function generateDeviceKeys(): DeviceKeys {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function priv(pem: string): KeyObject {
  return createPrivateKey(pem);
}

/** ECDSA-SHA256 signature over the invoice hash bytes, DER encoded, returned as base64. */
export function signInvoiceHash(invoiceHashB64: string, privateKeyPem: string): string {
  const data = Buffer.from(invoiceHashB64, "base64");
  return sign("sha256", data, priv(privateKeyPem)).toString("base64");
}

export function verifyInvoiceHash(invoiceHashB64: string, signatureB64: string, publicKeyPem: string): boolean {
  return verify(
    "sha256",
    Buffer.from(invoiceHashB64, "base64"),
    createPublicKey(publicKeyPem),
    Buffer.from(signatureB64, "base64"),
  );
}

/** DER (SPKI) bytes of the public key — QR tag 8. */
export function publicKeyDer(publicKeyPem: string): Buffer {
  return createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
}
