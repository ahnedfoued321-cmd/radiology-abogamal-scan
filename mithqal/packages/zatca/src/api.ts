/**
 * ZATCA Fatoora API client (Phase 2): device onboarding and document submission.
 * Endpoints and headers verified against the ZATCA developer-portal sandbox.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

export const ZATCA_BASE_URLS = {
  sandbox: "https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal",
  simulation: "https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation",
  production: "https://gw-fatoora.zatca.gov.sa/e-invoicing/core",
} as const;
export type ZatcaEnv = keyof typeof ZATCA_BASE_URLS;

const TEMPLATE: Record<ZatcaEnv, string> = {
  sandbox: "TSTZATCA-Code-Signing",
  simulation: "PREZATCA-Code-Signing",
  production: "ZATCA-Code-Signing",
};

export interface CsrInput {
  env: ZatcaEnv;
  commonName: string; // EGS unit name
  organization: string; // taxpayer name
  organizationUnit: string; // branch name (or TIN for VAT groups)
  vatNumber: string;
  serial: string; // "1-<solution>|2-<model/version>|3-<device uuid>"
  invoiceTypes: "1100" | "1000" | "0100"; // standard+simplified / standard only / simplified only
  address: string; // short national address or city
  businessCategory: string;
}

const clean = (s: string) => s.replace(/[\n\r=\\/,+]/g, " ").trim();

/**
 * Build the CSR with OpenSSL (secp256k1 key from the device). ZATCA rejects CSRs carrying
 * basicConstraints/keyUsage extensions, so only the template name and SAN are requested.
 */
export async function createCsr(privateKeyPem: string, c: CsrInput): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "zatca-csr-"));
  try {
    const cnf = [
      "oid_section = OIDs",
      "[ OIDs ]",
      "certificateTemplateName = 1.3.6.1.4.1.311.20.2",
      "[ req ]",
      "prompt = no",
      "utf8 = yes",
      "string_mask = utf8only",
      "distinguished_name = dn",
      "req_extensions = v3_req",
      "[ dn ]",
      "C = SA",
      `OU = ${clean(c.organizationUnit)}`,
      `O = ${clean(c.organization)}`,
      `CN = ${clean(c.commonName)}`,
      "[ v3_req ]",
      `certificateTemplateName = ASN1:PRINTABLESTRING:${TEMPLATE[c.env]}`,
      "subjectAltName = dirName:alt_names",
      "[ alt_names ]",
      `SN = ${clean(c.serial)}`,
      `UID = ${clean(c.vatNumber)}`,
      `title = ${c.invoiceTypes}`,
      `registeredAddress = ${clean(c.address)}`,
      `businessCategory = ${clean(c.businessCategory)}`,
      "",
    ].join("\n");
    await writeFile(path.join(dir, "csr.cnf"), cnf);
    await writeFile(path.join(dir, "key.pem"), privateKeyPem, { mode: 0o600 });
    await promisify(execFile)("openssl", ["req", "-new", "-sha256", "-key", "key.pem", "-config", "csr.cnf", "-out", "csr.pem"], { cwd: dir });
    return (await readFile(path.join(dir, "csr.pem"), "utf8")).trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface Csid {
  requestID: number | string;
  binarySecurityToken: string;
  secret: string;
}

export class ZatcaApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly body: unknown) {
    super(message);
  }
}

export class ZatcaApi {
  constructor(private readonly env: ZatcaEnv, private readonly fetchImpl: typeof fetch = fetch) {}

  private async call(p: string, init: { auth?: { token: string; secret: string }; otp?: string; body: unknown; clearance?: boolean }) {
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json", "Accept-Version": "V2", "Accept-Language": "en" };
    if (init.otp) headers.OTP = init.otp;
    if (init.auth) headers.Authorization = `Basic ${Buffer.from(`${init.auth.token}:${init.auth.secret}`).toString("base64")}`;
    if (init.clearance !== undefined) headers["Clearance-Status"] = init.clearance ? "1" : "0";
    const res = await this.fetchImpl(`${ZATCA_BASE_URLS[this.env]}${p}`, { method: "POST", headers, body: JSON.stringify(init.body) });
    const text = await res.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* plain-text error */
    }
    return { status: res.status, body };
  }

  async complianceCsid(csrPem: string, otp: string): Promise<Csid> {
    const r = await this.call("/compliance", { otp, body: { csr: Buffer.from(csrPem, "utf8").toString("base64") } });
    if (r.status !== 200 || !r.body?.binarySecurityToken) throw new ZatcaApiError(`Compliance CSID failed (${r.status})`, r.status, r.body);
    return r.body;
  }

  async complianceCheck(ccsid: Csid, doc: { hash: string; uuid: string; xml: string }) {
    return this.call("/compliance/invoices", {
      auth: { token: ccsid.binarySecurityToken, secret: ccsid.secret },
      body: { invoiceHash: doc.hash, uuid: doc.uuid, invoice: Buffer.from(doc.xml, "utf8").toString("base64") },
    });
  }

  async productionCsid(ccsid: Csid): Promise<Csid> {
    const r = await this.call("/production/csids", {
      auth: { token: ccsid.binarySecurityToken, secret: ccsid.secret },
      body: { compliance_request_id: String(ccsid.requestID) },
    });
    if (r.status !== 200 || !r.body?.binarySecurityToken) throw new ZatcaApiError(`Production CSID failed (${r.status})`, r.status, r.body);
    return r.body;
  }

  async submit(pcsid: { token: string; secret: string }, doc: { hash: string; uuid: string; xml: string; mode: "REPORTING" | "CLEARANCE" }) {
    const clearance = doc.mode === "CLEARANCE";
    return this.call(clearance ? "/invoices/clearance/single" : "/invoices/reporting/single", {
      auth: pcsid,
      clearance,
      body: { invoiceHash: doc.hash, uuid: doc.uuid, invoice: Buffer.from(doc.xml, "utf8").toString("base64") },
    });
  }
}
