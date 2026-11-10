-- Kitchen / barista display: one ticket per sales invoice with prepared (non-stock) menu items.
CREATE TABLE kds_tickets (
  invoice_id   uuid PRIMARY KEY REFERENCES sales_invoices(id),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  status       text NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW','READY','SERVED')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  ready_at     timestamptz,
  served_at    timestamptz
);
CREATE INDEX ON kds_tickets (tenant_id, status, created_at);
ALTER TABLE kds_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE kds_tickets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON kds_tickets USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
GRANT SELECT, INSERT, UPDATE ON kds_tickets TO mithqal_app;
