-- Commercial plans & module licensing. Prices are list prices in SAR / month (placeholders to be confirmed by the business).
CREATE TABLE plans (
  code            text PRIMARY KEY,
  name_ar         text NOT NULL,
  name_en         text NOT NULL,
  price_monthly   numeric(19,4) NOT NULL,
  max_users       int NOT NULL,
  max_terminals   int NOT NULL,
  max_vans        int NOT NULL,
  modules         text[] NOT NULL
);

INSERT INTO plans VALUES
  ('free',       'مجاني',     'Free',       0,   2,  1,  0, ARRAY['pos','inventory','accounting','einvoicing']),
  ('growth',     'نمو',       'Growth',     149, 5,  2,  1, ARRAY['pos','inventory','accounting','einvoicing','recipes','pharmacy','assistant','van_sales']),
  ('pro',        'احترافي',   'Pro',        349, 20, 5,  5, ARRAY['pos','inventory','accounting','einvoicing','recipes','pharmacy','assistant','van_sales','fraud_guard','multi_branch']),
  ('enterprise', 'مؤسسات',    'Enterprise', 0,   1000, 200, 200, ARRAY['pos','inventory','accounting','einvoicing','recipes','pharmacy','assistant','van_sales','fraud_guard','multi_branch','api']);

ALTER TABLE tenants ADD CONSTRAINT tenants_plan_fk FOREIGN KEY (plan) REFERENCES plans(code);
ALTER TABLE tenants ADD COLUMN trial_ends_at timestamptz;
ALTER TABLE tenants ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','past_due','suspended'));

-- Plans are global reference data (no tenant_id); readable by the app role.
GRANT SELECT ON plans TO mithqal_app;
