-- Saudi Social Insurance Law (Royal Decree M/273, effective 3 July 2024).
-- Applies only to first-time contributors registered on/after 2024-07-03; existing contributors keep
-- the previous rates. Annuities rise by 0.5 pt each July for both employee and employer until 11%.
-- Source schedule: GOSI announcements as summarised by payroll vendors; verify on gosi.gov.sa.

ALTER TABLE employees ADD COLUMN gosi_first_registered date; -- NULL = registered under the previous law

ALTER TABLE contribution_rules DROP CONSTRAINT contribution_rules_applies_to_check;
ALTER TABLE contribution_rules ADD CONSTRAINT contribution_rules_applies_to_check
  CHECK (applies_to IN ('NATIONAL','NATIONAL_NEW','EXPAT'));

INSERT INTO contribution_rules (country, applies_to, code, employee_pct, employer_pct, base, effective_from, note) VALUES
  ('SA','NATIONAL_NEW','ANNUITIES',  9.000,  9.000, 'BASIC_PLUS_HOUSING', '2024-07-03', 'new law, year 1'),
  ('SA','NATIONAL_NEW','ANNUITIES',  9.500,  9.500, 'BASIC_PLUS_HOUSING', '2025-07-03', 'new law step'),
  ('SA','NATIONAL_NEW','ANNUITIES', 10.000, 10.000, 'BASIC_PLUS_HOUSING', '2026-07-03', 'new law step'),
  ('SA','NATIONAL_NEW','ANNUITIES', 10.500, 10.500, 'BASIC_PLUS_HOUSING', '2027-07-03', 'new law step'),
  ('SA','NATIONAL_NEW','ANNUITIES', 11.000, 11.000, 'BASIC_PLUS_HOUSING', '2028-07-03', 'new law final'),
  ('SA','NATIONAL_NEW','SANED',      0.750,  0.750, 'BASIC_PLUS_HOUSING', '2024-07-03', 'unemployment insurance'),
  ('SA','NATIONAL_NEW','HAZARDS',    0.000,  2.000, 'BASIC_PLUS_HOUSING', '2024-07-03', 'occupational hazards');

UPDATE contribution_rules SET note = 'previous law (registered before 2024-07-03)' WHERE applies_to = 'NATIONAL' AND code = 'ANNUITIES';
