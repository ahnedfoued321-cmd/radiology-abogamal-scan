-- F&B pack: recipes (bill of materials). Selling a menu item consumes its ingredients from stock.
CREATE TABLE recipe_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  item_id        uuid NOT NULL REFERENCES items(id),         -- the menu item (e.g. Latte)
  ingredient_id  uuid NOT NULL REFERENCES items(id),         -- consumed stock item (e.g. Milk, ml)
  quantity       numeric(19,4) NOT NULL CHECK (quantity > 0), -- per 1 unit of the menu item
  UNIQUE (item_id, ingredient_id),
  CHECK (item_id <> ingredient_id)
);
ALTER TABLE items ADD COLUMN unit text NOT NULL DEFAULT 'pcs';

ALTER TABLE recipe_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipe_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON recipe_lines USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON recipe_lines TO mithqal_app;
