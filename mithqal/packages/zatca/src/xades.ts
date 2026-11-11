/**
 * ZATCA Phase 2 XAdES-B-B enveloped signature for UBL invoices.
 *
 * The device certificate is the ZATCA CSID (binarySecurityToken, base64-decoded once → the base64
 * DER certificate string). The structure, transforms and hashing rules follow ZATCA's e-invoice
 * security features spec; validated against ZATCA's sandbox compliance checker.
 */
import { createHash, X509Certificate } from "node:crypto";

export interface CertificateInfo {
  /** base64 DER certificate (no PEM header), as embedded in ds:X509Certificate */
  base64: string;
  /** base64(hex(sha256(base64 cert string))) — ZATCA's CertDigest convention */
  hash: string;
  issuer: string;
  serialNumber: string; // decimal
  publicKeyDer: Buffer;
  signature: Buffer; // the issuer's signature over the certificate (QR tag 9)
}

/** Accepts the CSID binarySecurityToken (base64 of the certificate string) or the certificate string itself. */
export function certificateFromCsid(tokenOrCert: string): CertificateInfo {
  const raw = tokenOrCert.trim();
  const decoded = Buffer.from(raw, "base64").toString("utf8");
  const base64 = /^MII[A-Za-z0-9+/=]+$/.test(decoded) ? decoded : raw;
  const der = Buffer.from(base64, "base64");
  const cert = new X509Certificate(der);
  return {
    base64,
    hash: Buffer.from(createHash("sha256").update(base64, "utf8").digest("hex"), "utf8").toString("base64"),
    issuer: cert.issuer.split("\n").reverse().join(", "),
    serialNumber: BigInt(`0x${cert.serialNumber}`).toString(10),
    publicKeyDer: cert.publicKey.export({ type: "spki", format: "der" }),
    signature: certificateSignature(der),
  };
}

/** Extract the signatureValue BIT STRING from a DER X.509 certificate. */
function certificateSignature(der: Buffer): Buffer {
  let pos = 0;
  const readTL = () => {
    const tag = der[pos++]!;
    let len = der[pos++]!;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let i = 0; i < n; i++) len = (len << 8) | der[pos++]!;
    }
    return { tag, len };
  };
  const outer = readTL();
  if (outer.tag !== 0x30) throw new Error("Invalid certificate");
  const tbs = readTL();
  pos += tbs.len;
  const alg = readTL();
  pos += alg.len;
  const sig = readTL();
  if (sig.tag !== 0x03) throw new Error("Invalid certificate signature");
  return der.subarray(pos + 1, pos + sig.len); // skip the "unused bits" byte
}

const SP = (n: number) => " ".repeat(n);

/** SignedProperties as hashed (each element carries its namespace declarations). */
export function signedPropertiesForHash(signingTime: string, cert: CertificateInfo): string {
  return (
    `<xades:SignedProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Id="xadesSignedProperties">\n` +
    `${SP(36)}<xades:SignedSignatureProperties>\n` +
    `${SP(40)}<xades:SigningTime>${signingTime}</xades:SigningTime>\n` +
    `${SP(40)}<xades:SigningCertificate>\n` +
    `${SP(44)}<xades:Cert>\n` +
    `${SP(48)}<xades:CertDigest>\n` +
    `${SP(52)}<ds:DigestMethod xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>\n` +
    `${SP(52)}<ds:DigestValue xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${cert.hash}</ds:DigestValue>\n` +
    `${SP(48)}</xades:CertDigest>\n` +
    `${SP(48)}<xades:IssuerSerial>\n` +
    `${SP(52)}<ds:X509IssuerName xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${cert.issuer}</ds:X509IssuerName>\n` +
    `${SP(52)}<ds:X509SerialNumber xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${cert.serialNumber}</ds:X509SerialNumber>\n` +
    `${SP(48)}</xades:IssuerSerial>\n` +
    `${SP(44)}</xades:Cert>\n` +
    `${SP(40)}</xades:SigningCertificate>\n` +
    `${SP(36)}</xades:SignedSignatureProperties>\n` +
    `${SP(32)}</xades:SignedProperties>`
  );
}

/** SignedProperties as embedded in the document (namespaces inherited from ancestors). */
function signedPropertiesEmbedded(signingTime: string, cert: CertificateInfo): string {
  return (
    `<xades:SignedProperties Id="xadesSignedProperties">\n` +
    `${SP(36)}<xades:SignedSignatureProperties>\n` +
    `${SP(40)}<xades:SigningTime>${signingTime}</xades:SigningTime>\n` +
    `${SP(40)}<xades:SigningCertificate>\n` +
    `${SP(44)}<xades:Cert>\n` +
    `${SP(48)}<xades:CertDigest>\n` +
    `${SP(52)}<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>\n` +
    `${SP(52)}<ds:DigestValue>${cert.hash}</ds:DigestValue>\n` +
    `${SP(48)}</xades:CertDigest>\n` +
    `${SP(48)}<xades:IssuerSerial>\n` +
    `${SP(52)}<ds:X509IssuerName>${cert.issuer}</ds:X509IssuerName>\n` +
    `${SP(52)}<ds:X509SerialNumber>${cert.serialNumber}</ds:X509SerialNumber>\n` +
    `${SP(48)}</xades:IssuerSerial>\n` +
    `${SP(44)}</xades:Cert>\n` +
    `${SP(40)}</xades:SigningCertificate>\n` +
    `${SP(36)}</xades:SignedSignatureProperties>\n` +
    `${SP(32)}</xades:SignedProperties>`
  );
}

/** Hex-then-base64 sha256, as ZATCA uses for the SignedProperties digest. */
export function signedPropertiesHash(xml: string): string {
  return Buffer.from(createHash("sha256").update(xml, "utf8").digest("hex"), "utf8").toString("base64");
}

/** The full <ext:UBLExtension> carrying the XAdES signature. */
export function ublSignatureExtension(p: { invoiceHash: string; signatureValue: string; signingTime: string; cert: CertificateInfo }): string {
  const spHash = signedPropertiesHash(signedPropertiesForHash(p.signingTime, p.cert));
  return (
    `<ext:UBLExtension>` +
    `<ext:ExtensionURI>urn:oasis:names:specification:ubl:dsig:enveloped:xades</ext:ExtensionURI>` +
    `<ext:ExtensionContent>` +
    `<sig:UBLDocumentSignatures xmlns:sig="urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2" ` +
    `xmlns:sac="urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2" ` +
    `xmlns:sbc="urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2">` +
    `<sac:SignatureInformation>` +
    `<cbc:ID>urn:oasis:names:specification:ubl:signature:1</cbc:ID>` +
    `<sbc:ReferencedSignatureID>urn:oasis:names:specification:ubl:signature:Invoice</sbc:ReferencedSignatureID>` +
    `<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Id="signature">` +
    `<ds:SignedInfo>` +
    `<ds:CanonicalizationMethod Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>` +
    `<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256"/>` +
    `<ds:Reference Id="invoiceSignedData" URI="">` +
    `<ds:Transforms>` +
    `<ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116"><ds:XPath>not(//ancestor-or-self::ext:UBLExtensions)</ds:XPath></ds:Transform>` +
    `<ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116"><ds:XPath>not(//ancestor-or-self::cac:Signature)</ds:XPath></ds:Transform>` +
    `<ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116"><ds:XPath>not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])</ds:XPath></ds:Transform>` +
    `<ds:Transform Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>` +
    `</ds:Transforms>` +
    `<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>` +
    `<ds:DigestValue>${p.invoiceHash}</ds:DigestValue>` +
    `</ds:Reference>` +
    `<ds:Reference Type="http://www.w3.org/2000/09/xmldsig#SignatureProperties" URI="#xadesSignedProperties">` +
    `<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>` +
    `<ds:DigestValue>${spHash}</ds:DigestValue>` +
    `</ds:Reference>` +
    `</ds:SignedInfo>` +
    `<ds:SignatureValue>${p.signatureValue}</ds:SignatureValue>` +
    `<ds:KeyInfo><ds:X509Data><ds:X509Certificate>${p.cert.base64}</ds:X509Certificate></ds:X509Data></ds:KeyInfo>` +
    `<ds:Object><xades:QualifyingProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Target="signature">` +
    `\n${SP(32)}${signedPropertiesEmbedded(p.signingTime, p.cert)}\n${SP(28)}` +
    `</xades:QualifyingProperties></ds:Object>` +
    `</ds:Signature>` +
    `</sac:SignatureInformation>` +
    `</sig:UBLDocumentSignatures>` +
    `</ext:ExtensionContent>` +
    `</ext:UBLExtension>`
  );
}
