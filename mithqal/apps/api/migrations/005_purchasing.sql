-- Purchasing: suppliers, purchase orders (with approval), goods receipts, supplier payments (AP).
CREATE TABLE suppliers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  name                text NOT NULL,
  phone               text,
  vat_number          text,
  payment_terms_days  int NOT NULL DEFAULT 30,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE purchase_orders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  supplier_id    uuid NOT NULL REFERENCES suppliers(id),
  warehouse_id   uuid NOT NULL REFERENCES warehouses(id),
  number         text NOT NULL,
  status         text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','PARTIAL','RECEIVED','CANCELLED')),
  note           text,
  created_by     uuid,
  approved_by    uuid,
  approved_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);

CREATE TABLE purchase_order_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  po_id         uuid NOT NULL REFERENCES purchase_orders(id),
  item_id       uuid NOT NULL REFERENCES items(id),
  quantity      numeric(19,4) NOT NULL CHECK (quantity > 0),
  unit_cost     numeric(19,4) NOT NULL CHECK (unit_cost >= 0),
  received_qty  numeric(19,4) NOT NULL DEFAULT 0,
  UNIQUE (po_id, item_id)
);

CREATE TABLE goods_receipts (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  supplier_id  uuid REFERENCES suppliers(id),
  po_id        uuid REFERENCES purchase_orders(id),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  reference    text NOT NULL,
  net          numeric(19,4) NOT NULL,
  tax          numeric(19,4) NOT NULL,
  paid_cash    boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER goods_receipts_immutable BEFORE UPDATE OR DELETE ON goods_receipts FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE supplier_payments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  client_uuid  uuid NOT NULL,
  supplier_id  uuid NOT NULL REFERENCES suppliers(id),
  method       text NOT NULL CHECK (method IN ('CASH','BANK_TRANSFER','CHEQUE')),
  amount       numeric(19,4) NOT NULL CHECK (amount > 0),
  reference    text,
  paid_at      timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  UNIQUE (tenant_id, client_uuid)
);
CREATE TRIGGER supplier_payments_immutable BEFORE UPDATE OR DELETE ON supplier_payments FOR EACH ROW EXECUTE FUNCTION forbid_change();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['suppliers','purchase_orders','purchase_order_lines','goods_receipts','supplier_payments']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
  END LOOP;
END$$;
GRANT SELECT, INSERT, UPDATE, DELETE ON suppliers, purchase_orders, purchase_order_lines, goods_receipts, supplier_payments TO mithqal_app;
