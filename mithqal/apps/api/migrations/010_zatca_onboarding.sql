-- Per-device ZATCA onboarding (CSR → compliance CSID → compliance checks → production CSID).
-- DEV NOTE: secrets are stored in the database for now; production keeps them in a KMS/HSM
-- and stores only references here.
ALTER TABLE pos_terminals
  ADD COLUMN zatca_env           text CHECK (zatca_env IN ('sandbox','simulation','production')),
  ADD COLUMN zatca_ccsid_token   text,
  ADD COLUMN zatca_ccsid_secret  text,
  ADD COLUMN zatca_pcsid_token   text,
  ADD COLUMN zatca_pcsid_secret  text,
  ADD COLUMN zatca_onboarded_at  timestamptz,
  ADD COLUMN zatca_last_error    text;
