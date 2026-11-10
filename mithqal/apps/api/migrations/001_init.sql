-- Mithqal core schema (KSA MVP). Multi-tenant with Row-Level Security on every tenant table.
-- Runtime connects as the non-superuser role `mithqal_app`, so RLS is always enforced.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mithqal_app') THEN
    CREATE ROLE mithqal_app LOGIN PASSWORD 'mithqal_app' NOSUPERUSER NOBYPASSRLS;
  END IF;
END$$;

CREATE OR REPLACE FUNCTION current_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

-- ───────────────────────── Organization ─────────────────────────
CREATE TABLE tenants (
  id          uuid PRIMARY KEY,
  name        text NOT NULL,
  country     char(2) NOT NULL CHECK (country IN ('SA','EG','AE','KW','QA','BH','OM','JO')),
  plan        text NOT NULL DEFAULT 'free',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE companies (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  name_ar               text NOT NULL,
  name_en               text,
  vat_number            text,
  cr_number             text,
  street                text, building_number text, district text, city text, postal_code text,
  country               char(2) NOT NULL,
  currency              char(3) NOT NULL,
  vat_percent           numeric(5,2) NOT NULL,
  prices_include_tax    boolean NOT NULL DEFAULT true,
  allow_negative_stock  boolean NOT NULL DEFAULT true,
  industry              text NOT NULL DEFAULT 'retail' CHECK (industry IN ('retail','cafe','restaurant','pharmacy','distribution','services')),
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE branches (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  company_id uuid NOT NULL REFERENCES companies(id),
  name       text NOT NULL
);

CREATE TABLE warehouses (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  branch_id  uuid NOT NULL REFERENCES branches(id),
  name       text NOT NULL
);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  email          text NOT NULL UNIQUE,
  password_hash  text NOT NULL,
  full_name      text NOT NULL,
  role           text NOT NULL CHECK (role IN ('owner','accountant','cashier','storekeeper','sales_rep')),
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── Accounting ─────────────────────────
CREATE TABLE accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  code        text NOT NULL,
  name_ar     text NOT NULL,
  name_en     text NOT NULL,
  type        text NOT NULL CHECK (type IN ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE')),
  parent_code text,
  role        text,
  postable    boolean NOT NULL,
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, role)
);

CREATE TABLE journal_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  entry_date   date NOT NULL,
  memo         text NOT NULL,
  source_type  text NOT NULL,
  source_id    uuid,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE journal_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  entry_id    uuid NOT NULL REFERENCES journal_entries(id),
  account_id  uuid NOT NULL REFERENCES accounts(id),
  debit       numeric(19,4) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit      numeric(19,4) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  memo        text,
  CHECK (NOT (debit > 0 AND credit > 0)),
  CHECK (debit > 0 OR credit > 0)
);
CREATE INDEX ON journal_lines (tenant_id, account_id);
CREATE INDEX ON journal_lines (entry_id);

-- Double-entry invariant enforced by the database, checked at COMMIT.
CREATE OR REPLACE FUNCTION check_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d numeric; c numeric; n int;
BEGIN
  SELECT coalesce(sum(debit),0), coalesce(sum(credit),0), count(*) INTO d, c, n
  FROM journal_lines WHERE entry_id = NEW.entry_id;
  IF n < 2 OR d <> c THEN
    RAISE EXCEPTION 'Journal entry % is not balanced (debit %, credit %, lines %)', NEW.entry_id, d, c, n;
  END IF;
  RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER journal_balanced AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_entry_balanced();

-- Posted ledger is append-only.
CREATE OR REPLACE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only; post a reversing document instead', TG_TABLE_NAME; END$$;
CREATE TRIGGER journal_lines_immutable BEFORE UPDATE OR DELETE ON journal_lines FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER journal_entries_immutable BEFORE UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ───────────────────────── Catalog & inventory ─────────────────────────
CREATE TABLE items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  sku            text NOT NULL,
  barcode        text,
  name_ar        text NOT NULL,
  name_en        text,
  category       text,
  price          numeric(19,4) NOT NULL CHECK (price >= 0),
  tax_percent    numeric(5,2) NOT NULL,
  track_stock    boolean NOT NULL DEFAULT true,
  track_batches  boolean NOT NULL DEFAULT false,
  reorder_level  numeric(19,4) NOT NULL DEFAULT 0,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sku)
);
CREATE UNIQUE INDEX items_barcode_uq ON items (tenant_id, barcode) WHERE barcode IS NOT NULL;

CREATE TABLE stock_balances (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  item_id       uuid NOT NULL REFERENCES items(id),
  warehouse_id  uuid NOT NULL REFERENCES warehouses(id),
  quantity      numeric(19,4) NOT NULL DEFAULT 0,
  average_cost  numeric(19,4) NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id, warehouse_id)
);

CREATE TABLE item_batches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  item_id       uuid NOT NULL REFERENCES items(id),
  warehouse_id  uuid NOT NULL REFERENCES warehouses(id),
  batch_no      text NOT NULL,
  expiry_date   date,
  quantity      numeric(19,4) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  UNIQUE (item_id, warehouse_id, batch_no)
);

CREATE TABLE stock_moves (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  item_id       uuid NOT NULL REFERENCES items(id),
  warehouse_id  uuid NOT NULL REFERENCES warehouses(id),
  batch_id      uuid REFERENCES item_batches(id),
  quantity      numeric(19,4) NOT NULL CHECK (quantity <> 0), -- signed: + in, - out
  unit_cost     numeric(19,4) NOT NULL,
  source_type   text NOT NULL,
  source_id     uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON stock_moves (tenant_id, item_id, created_at);
CREATE TRIGGER stock_moves_immutable BEFORE UPDATE OR DELETE ON stock_moves FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ───────────────────────── POS & sales ─────────────────────────
CREATE TABLE pos_terminals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  branch_id        uuid NOT NULL REFERENCES branches(id),
  warehouse_id     uuid NOT NULL REFERENCES warehouses(id),
  name             text NOT NULL,
  prefix           text NOT NULL,
  invoice_seq      bigint NOT NULL DEFAULT 0,
  icv              bigint NOT NULL DEFAULT 0,
  last_hash        text NOT NULL,
  -- DEV ONLY: production stores the private key in a KMS/HSM and keeps only a key reference here.
  private_key_pem  text NOT NULL,
  public_key_pem   text NOT NULL,
  zatca_status     text NOT NULL DEFAULT 'NOT_ONBOARDED',
  UNIQUE (tenant_id, prefix)
);

CREATE TABLE customers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  name        text NOT NULL,
  phone       text,
  vat_number  text,
  cr_number   text,
  street text, building_number text, district text, city text, postal_code text, country char(2),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sales_invoices (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  branch_id            uuid NOT NULL REFERENCES branches(id),
  terminal_id          uuid NOT NULL REFERENCES pos_terminals(id),
  customer_id          uuid REFERENCES customers(id),
  client_uuid          uuid NOT NULL,
  number               text NOT NULL,
  kind                 text NOT NULL CHECK (kind IN ('SIMPLIFIED','STANDARD')),
  doc_type             text NOT NULL CHECK (doc_type IN ('INVOICE','CREDIT_NOTE','DEBIT_NOTE')),
  original_invoice_id  uuid REFERENCES sales_invoices(id),
  reason               text,
  currency             char(3) NOT NULL,
  total_net            numeric(19,4) NOT NULL,
  total_discount       numeric(19,4) NOT NULL,
  total_tax            numeric(19,4) NOT NULL,
  total_gross          numeric(19,4) NOT NULL,
  cost_of_goods        numeric(19,4) NOT NULL,
  issued_at            timestamptz NOT NULL,
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, client_uuid),
  UNIQUE (tenant_id, number)
);
CREATE INDEX ON sales_invoices (tenant_id, issued_at);
CREATE TRIGGER sales_invoices_immutable BEFORE UPDATE OR DELETE ON sales_invoices FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE sales_invoice_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  invoice_id    uuid NOT NULL REFERENCES sales_invoices(id),
  line_no       int NOT NULL,
  item_id       uuid NOT NULL REFERENCES items(id),
  name          text NOT NULL,
  quantity      numeric(19,4) NOT NULL,
  unit_net      numeric(19,4) NOT NULL,
  discount_net  numeric(19,4) NOT NULL,
  net           numeric(19,4) NOT NULL,
  tax_percent   numeric(5,2) NOT NULL,
  tax           numeric(19,4) NOT NULL,
  gross         numeric(19,4) NOT NULL,
  tax_category  char(1) NOT NULL,
  unit_cost     numeric(19,4) NOT NULL DEFAULT 0
);
CREATE TRIGGER sales_invoice_lines_immutable BEFORE UPDATE OR DELETE ON sales_invoice_lines FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE payments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  invoice_id  uuid NOT NULL REFERENCES sales_invoices(id),
  method      text NOT NULL CHECK (method IN ('CASH','CARD','CREDIT')),
  amount      numeric(19,4) NOT NULL
);

-- ───────────────────────── E-invoicing ─────────────────────────
CREATE TABLE e_invoice_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  invoice_id    uuid NOT NULL UNIQUE REFERENCES sales_invoices(id),
  terminal_id   uuid NOT NULL REFERENCES pos_terminals(id),
  authority     text NOT NULL CHECK (authority IN ('ZATCA','ETA')),
  mode          text NOT NULL CHECK (mode IN ('REPORTING','CLEARANCE','RECEIPT')),
  icv           bigint NOT NULL,
  pih           text NOT NULL,
  hash          text NOT NULL,
  signature     text NOT NULL,
  qr            text NOT NULL,
  xml           text NOT NULL,
  status        text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACCEPTED','WARNING','REJECTED')),
  attempts      int NOT NULL DEFAULT 0,
  last_error    text,
  response      jsonb,
  submitted_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (terminal_id, icv)
);
CREATE INDEX ON e_invoice_documents (status, created_at);

-- ───────────────────────── Events & audit ─────────────────────────
CREATE TABLE domain_events (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  type          text NOT NULL,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz
);

CREATE TABLE audit_logs (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  actor_id    uuid,
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text,
  data        jsonb,
  prev_hash   text NOT NULL,
  hash        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ───────────────────────── Row-Level Security ─────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['companies','branches','warehouses','users','accounts','journal_entries','journal_lines',
    'items','stock_balances','item_batches','stock_moves','pos_terminals','customers','sales_invoices',
    'sales_invoice_lines','payments','e_invoice_documents','domain_events','audit_logs']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
  END LOOP;
END$$;
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants USING (id = current_tenant()) WITH CHECK (id = current_tenant());

-- Login needs to find a user before a tenant is known: a narrow SECURITY DEFINER lookup.
CREATE OR REPLACE FUNCTION auth_lookup(p_email text)
RETURNS TABLE (user_id uuid, tenant_id uuid, password_hash text, role text, full_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id, tenant_id, password_hash, role, full_name FROM users WHERE email = lower(p_email) AND active
$$;
REVOKE ALL ON FUNCTION auth_lookup(text) FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO mithqal_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mithqal_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO mithqal_app;
GRANT EXECUTE ON FUNCTION auth_lookup(text), current_tenant() TO mithqal_app;
