CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),name TEXT NOT NULL,city TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'planning',created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS project_units(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),project_id TEXT NOT NULL REFERENCES projects(id),unit_code TEXT NOT NULL,price NUMERIC NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'available',UNIQUE(project_id,unit_code));
CREATE TABLE IF NOT EXISTS crm_contacts(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),name TEXT NOT NULL,phone TEXT NOT NULL DEFAULT '',email TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS crm_deals(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),contact_id TEXT REFERENCES crm_contacts(id),listing_id TEXT REFERENCES listings(id),assigned_to TEXT REFERENCES users(id),stage TEXT NOT NULL DEFAULT 'new',amount NUMERIC NOT NULL DEFAULT 0,created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS broker_referrals(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),deal_id TEXT NOT NULL REFERENCES crm_deals(id),broker_id TEXT NOT NULL REFERENCES users(id),commission_rate NUMERIC NOT NULL DEFAULT 0,commission_amount NUMERIC NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'pending',created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS rental_contracts(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),listing_id TEXT NOT NULL REFERENCES listings(id),tenant_name TEXT NOT NULL,start_date DATE NOT NULL,end_date DATE NOT NULL,rent_amount NUMERIC NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'draft',created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS maintenance_tickets(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),listing_id TEXT REFERENCES listings(id),title TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS rent_payments(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),contract_id TEXT NOT NULL REFERENCES rental_contracts(id),amount NUMERIC NOT NULL,due_date DATE NOT NULL,paid_at TIMESTAMPTZ,status TEXT NOT NULL DEFAULT 'due',created_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id);
CREATE INDEX IF NOT EXISTS idx_units_org ON project_units(org_id);
CREATE INDEX IF NOT EXISTS idx_contacts_org ON crm_contacts(org_id);
CREATE INDEX IF NOT EXISTS idx_deals_org ON crm_deals(org_id);
CREATE INDEX IF NOT EXISTS idx_referrals_org ON broker_referrals(org_id);
CREATE INDEX IF NOT EXISTS idx_contracts_org ON rental_contracts(org_id);
CREATE INDEX IF NOT EXISTS idx_tickets_org ON maintenance_tickets(org_id);
CREATE INDEX IF NOT EXISTS idx_payments_org ON rent_payments(org_id);
-- Accounts, membership and ownership. Existing data is preserved.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS created_by TEXT REFERENCES users(id);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS organization_type TEXT NOT NULL DEFAULT 'agency';
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE listings ADD COLUMN IF NOT EXISTS created_by TEXT REFERENCES users(id);
ALTER TABLE listings ADD COLUMN IF NOT EXISTS updated_by TEXT REFERENCES users(id);
ALTER TABLE listings ADD COLUMN IF NOT EXISTS section TEXT NOT NULL DEFAULT 'marketplace';
ALTER TABLE listings ADD COLUMN IF NOT EXISTS owner_user_id TEXT REFERENCES users(id);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS created_by TEXT REFERENCES users(id);
ALTER TABLE project_units ADD COLUMN IF NOT EXISTS created_by TEXT REFERENCES users(id);
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS created_by TEXT REFERENCES users(id);
ALTER TABLE crm_deals ADD COLUMN IF NOT EXISTS created_by TEXT REFERENCES users(id);
ALTER TABLE broker_referrals ADD COLUMN IF NOT EXISTS created_by TEXT REFERENCES users(id);
ALTER TABLE rental_contracts ADD COLUMN IF NOT EXISTS created_by TEXT REFERENCES users(id);
ALTER TABLE maintenance_tickets ADD COLUMN IF NOT EXISTS created_by TEXT REFERENCES users(id);
ALTER TABLE rent_payments ADD COLUMN IF NOT EXISTS created_by TEXT REFERENCES users(id);
CREATE TABLE IF NOT EXISTS organization_memberships(
 id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),
 user_id TEXT NOT NULL REFERENCES users(id),role TEXT NOT NULL
 CHECK(role IN ('org_admin','agent','broker','developer','property_manager','viewer')),
 status TEXT NOT NULL DEFAULT 'pending'
 CHECK(status IN ('pending','active','suspended','rejected')),
 invited_by TEXT REFERENCES users(id),created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(org_id,user_id));
CREATE TABLE IF NOT EXISTS account_profiles(
 user_id TEXT PRIMARY KEY REFERENCES users(id),
 account_type TEXT NOT NULL DEFAULT 'customer'
 CHECK(account_type IN ('customer','owner','agency','developer','broker','property_manager')),
 phone TEXT NOT NULL DEFAULT '',verified BOOLEAN NOT NULL DEFAULT false,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS account_applications(
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),
 requested_type TEXT NOT NULL CHECK(requested_type IN ('owner','agency','developer','broker','property_manager')),
 org_id TEXT REFERENCES organizations(id),
 status TEXT NOT NULL DEFAULT 'pending'
 CHECK(status IN ('pending','approved','rejected')),
 reviewed_by TEXT REFERENCES users(id),reviewed_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS audit_events(
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 actor_user_id TEXT REFERENCES users(id),org_id TEXT REFERENCES organizations(id),
 entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,action TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_listings_author ON listings(created_by);
CREATE INDEX IF NOT EXISTS idx_listings_section_org ON listings(section,org_id);
CREATE INDEX IF NOT EXISTS idx_membership_user ON organization_memberships(user_id,status);
CREATE INDEX IF NOT EXISTS idx_application_user ON account_applications(user_id,status);
CREATE INDEX IF NOT EXISTS idx_audit_org_time ON audit_events(org_id,created_at DESC);

-- Validate tenant ownership for all new or modified module records.
CREATE OR REPLACE FUNCTION sakango_check_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE author_org TEXT; author_role TEXT; related_org TEXT;
BEGIN
 IF NEW.created_by IS NOT NULL THEN
   SELECT org_id,role INTO author_org,author_role FROM users WHERE id=NEW.created_by;
   IF author_role IS NULL THEN RAISE EXCEPTION 'Unknown author'; END IF;
   IF author_role <> 'superadmin' AND NOT EXISTS (
     SELECT 1 FROM organization_memberships m WHERE m.user_id=NEW.created_by
       AND m.org_id=NEW.org_id AND m.status='active'
   ) AND author_org IS DISTINCT FROM NEW.org_id THEN
     RAISE EXCEPTION 'Author is not a member of this organization';
   END IF;
 END IF;
 IF TG_TABLE_NAME='project_units' THEN
   SELECT org_id INTO related_org FROM projects WHERE id=NEW.project_id;
 ELSIF TG_TABLE_NAME='broker_referrals' THEN
   SELECT org_id INTO related_org FROM crm_deals WHERE id=NEW.deal_id;
 ELSIF TG_TABLE_NAME='rent_payments' THEN
   SELECT org_id INTO related_org FROM rental_contracts WHERE id=NEW.contract_id;
 ELSIF TG_TABLE_NAME='crm_deals' AND NEW.contact_id IS NOT NULL THEN
   SELECT org_id INTO related_org FROM crm_contacts WHERE id=NEW.contact_id;
 ELSIF TG_TABLE_NAME='maintenance_tickets' AND NEW.listing_id IS NOT NULL THEN
   SELECT org_id INTO related_org FROM listings WHERE id=NEW.listing_id;
 ELSIF TG_TABLE_NAME='rental_contracts' THEN
   SELECT org_id INTO related_org FROM listings WHERE id=NEW.listing_id;
 END IF;
 IF related_org IS NOT NULL AND related_org IS DISTINCT FROM NEW.org_id THEN
   RAISE EXCEPTION 'Cross-organization reference is forbidden';
 END IF;
 RETURN NEW;
END $$;
DO $$
DECLARE t TEXT;
BEGIN
 FOREACH t IN ARRAY ARRAY['listings','projects','project_units','crm_contacts','crm_deals','broker_referrals','rental_contracts','maintenance_tickets','rent_payments']
 LOOP
   EXECUTE format('DROP TRIGGER IF EXISTS sakango_tenant_guard ON %I',t);
   EXECUTE format('CREATE TRIGGER sakango_tenant_guard BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION sakango_check_tenant()',t);
 END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS user_permissions(
 user_id TEXT NOT NULL REFERENCES users(id),
 permission TEXT NOT NULL CHECK(permission IN ('dashboard_view','reports_view','reports_export')),
 granted_by TEXT NOT NULL REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,permission));
CREATE INDEX IF NOT EXISTS idx_user_permissions_user ON user_permissions(user_id);
