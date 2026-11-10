-- HR & payroll (KSA first). Contribution rates are effective-dated settings, never hard-coded.
CREATE TABLE employees (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  user_id         uuid REFERENCES users(id),
  full_name       text NOT NULL,
  nationality     char(2) NOT NULL,                  -- ISO country; drives social-insurance rules
  national_id     text,                              -- national ID / iqama number
  iban            text,
  hire_date       date NOT NULL,
  basic_salary    numeric(19,4) NOT NULL CHECK (basic_salary >= 0),
  housing         numeric(19,4) NOT NULL DEFAULT 0,
  transport       numeric(19,4) NOT NULL DEFAULT 0,
  other_allowances numeric(19,4) NOT NULL DEFAULT 0,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE employee_documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  employee_id  uuid NOT NULL REFERENCES employees(id),
  kind         text NOT NULL CHECK (kind IN ('IQAMA','PASSPORT','HEALTH_CERT','DRIVING_LICENSE','CONTRACT','OTHER')),
  number       text,
  expiry_date  date NOT NULL
);

-- Social insurance rules per country (global reference data, effective-dated).
CREATE TABLE contribution_rules (
  id              serial PRIMARY KEY,
  country         char(2) NOT NULL,          -- payroll country (SA)
  applies_to      text NOT NULL CHECK (applies_to IN ('NATIONAL','EXPAT')),
  code            text NOT NULL,             -- e.g. ANNUITIES, SANED, HAZARDS
  employee_pct    numeric(6,3) NOT NULL,
  employer_pct    numeric(6,3) NOT NULL,
  base            text NOT NULL CHECK (base IN ('BASIC_PLUS_HOUSING')),
  effective_from  date NOT NULL,
  note            text
);
-- Defaults for development; VERIFY against current GOSI regulations before production use
-- (annuity rates for new entrants change under the 2024 social insurance law).
INSERT INTO contribution_rules (country, applies_to, code, employee_pct, employer_pct, base, effective_from, note) VALUES
  ('SA','NATIONAL','ANNUITIES', 9.000, 9.000, 'BASIC_PLUS_HOUSING', '2000-01-01', 'verify for post-2024 entrants'),
  ('SA','NATIONAL','SANED',     0.750, 0.750, 'BASIC_PLUS_HOUSING', '2000-01-01', 'unemployment insurance'),
  ('SA','NATIONAL','HAZARDS',   0.000, 2.000, 'BASIC_PLUS_HOUSING', '2000-01-01', 'occupational hazards'),
  ('SA','EXPAT',   'HAZARDS',   0.000, 2.000, 'BASIC_PLUS_HOUSING', '2000-01-01', 'occupational hazards');
GRANT SELECT ON contribution_rules TO mithqal_app;

CREATE TABLE payroll_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  period       char(7) NOT NULL,              -- YYYY-MM
  status       text NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED')),
  gross        numeric(19,4) NOT NULL,
  employee_contrib numeric(19,4) NOT NULL,
  employer_contrib numeric(19,4) NOT NULL,
  deductions   numeric(19,4) NOT NULL,
  net_pay      numeric(19,4) NOT NULL,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period)
);

CREATE TABLE payslips (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  run_id           uuid NOT NULL REFERENCES payroll_runs(id),
  employee_id      uuid NOT NULL REFERENCES employees(id),
  basic            numeric(19,4) NOT NULL,
  allowances       numeric(19,4) NOT NULL,
  gross            numeric(19,4) NOT NULL,
  employee_contrib numeric(19,4) NOT NULL,
  employer_contrib numeric(19,4) NOT NULL,
  deductions       numeric(19,4) NOT NULL,
  net_pay          numeric(19,4) NOT NULL,
  breakdown        jsonb NOT NULL
);
CREATE TRIGGER payroll_runs_immutable BEFORE UPDATE OR DELETE ON payroll_runs FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER payslips_immutable BEFORE UPDATE OR DELETE ON payslips FOR EACH ROW EXECUTE FUNCTION forbid_change();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['employees','employee_documents','payroll_runs','payslips']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
  END LOOP;
END$$;
GRANT SELECT, INSERT, UPDATE, DELETE ON employees, employee_documents, payroll_runs, payslips TO mithqal_app;

-- New posting roles for payroll; add the accounts to every existing tenant's chart.
UPDATE accounts SET role = 'SALARIES_EXPENSE' WHERE code = '5201' AND role IS NULL;
INSERT INTO accounts (tenant_id, code, name_ar, name_en, type, parent_code, role, postable)
SELECT t.id, a.code, a.name_ar, a.name_en, a.type, a.parent_code, a.role, true
  FROM tenants t
 CROSS JOIN (VALUES
   ('2120','رواتب مستحقة','Salaries payable','LIABILITY','21','SALARIES_PAYABLE'),
   ('2130','التأمينات الاجتماعية مستحقة','Social insurance payable','LIABILITY','21','SOCIAL_INSURANCE_PAYABLE'),
   ('5203','حصة المنشأة في التأمينات الاجتماعية','Employer social insurance','EXPENSE','5','SOCIAL_INSURANCE_EXPENSE')
 ) AS a(code, name_ar, name_en, type, parent_code, role)
ON CONFLICT DO NOTHING;

-- HR & payroll is part of Growth and above.
UPDATE plans SET modules = array_append(modules, 'hr') WHERE code IN ('growth','pro','enterprise') AND NOT ('hr' = ANY(modules));
