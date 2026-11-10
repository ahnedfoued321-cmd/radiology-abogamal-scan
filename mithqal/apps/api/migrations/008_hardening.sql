-- Hardening from the independent review.

-- (1) An invoice can be credited at most once, even under concurrent requests.
CREATE UNIQUE INDEX sales_invoices_one_credit_note ON sales_invoices (original_invoice_id) WHERE doc_type = 'CREDIT_NOTE';

-- (8) E-invoice retries with backoff instead of giving up.
ALTER TABLE e_invoice_documents ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX e_invoice_documents_due ON e_invoice_documents (status, next_attempt_at);

-- (13) Every request re-checks that the user is still active and still has the role in the token.
CREATE OR REPLACE FUNCTION auth_user_status(p_user uuid)
RETURNS TABLE (tenant_id uuid, role text, active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT tenant_id, role, active FROM users WHERE id = p_user
$$;
REVOKE ALL ON FUNCTION auth_user_status(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_user_status(uuid) TO mithqal_app;
