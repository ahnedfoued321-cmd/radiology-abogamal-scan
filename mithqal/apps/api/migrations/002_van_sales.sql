-- Van sales & field force ("Mithqal Khuta"), customer credit and collections.

ALTER TABLE customers
  ADD COLUMN latitude      numeric(9,6),
  ADD COLUMN longitude     numeric(9,6),
  ADD COLUMN credit_limit  numeric(19,4) NOT NULL DEFAULT 0,
  ADD COLUMN route_day     smallint CHECK (route_day BETWEEN 0 AND 6); -- 0 = Sunday

-- A sales rep drives a van = a dedicated warehouse + a POS terminal (its own ZATCA device chain).
CREATE TABLE van_assignments (
  user_id       uuid PRIMARY KEY REFERENCES users(id),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  warehouse_id  uuid NOT NULL UNIQUE REFERENCES warehouses(id),
  terminal_id   uuid NOT NULL UNIQUE REFERENCES pos_terminals(id),
  vehicle_plate text
);

CREATE TABLE stock_transfers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  from_warehouse_id  uuid NOT NULL REFERENCES warehouses(id),
  to_warehouse_id    uuid NOT NULL REFERENCES warehouses(id),
  reference          text,
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (from_warehouse_id <> to_warehouse_id)
);

CREATE TABLE visits (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  customer_id     uuid NOT NULL REFERENCES customers(id),
  check_in_at     timestamptz NOT NULL DEFAULT now(),
  check_in_lat    numeric(9,6),
  check_in_lng    numeric(9,6),
  distance_m      int,              -- distance from the customer's registered location
  outside_geofence boolean NOT NULL DEFAULT false,
  check_out_at    timestamptz,
  outcome         text CHECK (outcome IN ('SOLD','COLLECTED','NO_ORDER','CLOSED','OTHER')),
  note            text
);
CREATE INDEX ON visits (tenant_id, user_id, check_in_at);

CREATE TABLE collections (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  client_uuid  uuid NOT NULL,
  customer_id  uuid NOT NULL REFERENCES customers(id),
  user_id      uuid REFERENCES users(id),
  visit_id     uuid REFERENCES visits(id),
  method       text NOT NULL CHECK (method IN ('CASH','CARD','BANK_TRANSFER','CHEQUE')),
  amount       numeric(19,4) NOT NULL CHECK (amount > 0),
  reference    text,
  collected_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, client_uuid)
);
CREATE TRIGGER collections_immutable BEFORE UPDATE OR DELETE ON collections FOR EACH ROW EXECUTE FUNCTION forbid_change();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['van_assignments','stock_transfers','visits','collections']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
  END LOOP;
END$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON van_assignments, stock_transfers, visits, collections TO mithqal_app;
