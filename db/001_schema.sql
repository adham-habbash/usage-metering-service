BEGIN;

-- =========================================
-- 1. Accounts
-- =========================================

CREATE TABLE IF NOT EXISTS accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(120) NOT NULL
        CHECK (length(btrim(name)) BETWEEN 1 AND 120),

    -- Store the SHA-256 hash, never the raw API key.
    api_key_hash VARCHAR(64) NOT NULL UNIQUE
        CHECK (length(api_key_hash) = 64),
    api_key_prefix VARCHAR(16) NOT NULL,

    account_plan_id UUID NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =========================================
-- 2. Plans
-- =========================================

CREATE TABLE IF NOT EXISTS plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    name VARCHAR(100) NOT NULL
        CHECK (length(btrim(name)) BETWEEN 1 AND 100),

    scope VARCHAR(10) NOT NULL
        CHECK (scope IN ('account', 'user')),

    -- NULL for predefined plans; account ID for custom plans.
    owner_account_id UUID REFERENCES accounts(id) ON DELETE RESTRICT,

    monthly_allowance BIGINT NOT NULL
        CHECK (monthly_allowance > 0),

    max_units_per_request BIGINT NOT NULL
        CHECK (
            max_units_per_request > 0
            AND max_units_per_request <= monthly_allowance
        ),

    is_predefined BOOLEAN NOT NULL DEFAULT FALSE,

    version INTEGER NOT NULL DEFAULT 1
        CHECK (version > 0),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT plans_owner_predefined_check CHECK (
        (is_predefined = TRUE AND owner_account_id IS NULL)
        OR
        (is_predefined = FALSE AND owner_account_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS plans_predefined_name_unique
    ON plans (scope, lower(name))
    WHERE is_predefined = TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS plans_custom_name_unique
    ON plans (owner_account_id, scope, lower(name))
    WHERE is_predefined = FALSE;

-- Connect each account to its selected account plan.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'fk_accounts_account_plan'
          AND conrelid = 'accounts'::regclass
    ) THEN
        ALTER TABLE accounts
            ADD CONSTRAINT fk_accounts_account_plan
            FOREIGN KEY (account_plan_id)
            REFERENCES plans(id)
            ON DELETE RESTRICT;
    END IF;
END;
$$;

-- =========================================
-- 3. Users
-- =========================================

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    account_id UUID NOT NULL
        REFERENCES accounts(id) ON DELETE RESTRICT,

    external_user_id VARCHAR(128) NOT NULL
        CHECK (length(btrim(external_user_id)) BETWEEN 1 AND 128),

    display_name VARCHAR(120) NOT NULL
        CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),

    user_plan_id UUID NOT NULL
        REFERENCES plans(id) ON DELETE RESTRICT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT users_account_external_id_unique
        UNIQUE (account_id, external_user_id),

    -- Required for the composite foreign key in request history.
    CONSTRAINT users_id_account_unique
        UNIQUE (id, account_id)
);

-- =========================================
-- 4. Validate plan assignments
-- =========================================

CREATE OR REPLACE FUNCTION validate_account_plan_assignment()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    selected_scope VARCHAR(10);
    selected_owner UUID;
BEGIN
    SELECT scope, owner_account_id
      INTO selected_scope, selected_owner
      FROM plans
     WHERE id = NEW.account_plan_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Account plan does not exist'
            USING ERRCODE = '23503';
    END IF;

    IF selected_scope <> 'account' THEN
        RAISE EXCEPTION 'Account requires an account-scope plan'
            USING ERRCODE = '23514';
    END IF;

    IF selected_owner IS NOT NULL AND selected_owner <> NEW.id THEN
        RAISE EXCEPTION 'Plan belongs to a different account'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS accounts_validate_plan ON accounts;

CREATE TRIGGER accounts_validate_plan
BEFORE INSERT OR UPDATE OF account_plan_id ON accounts
FOR EACH ROW
EXECUTE FUNCTION validate_account_plan_assignment();


CREATE OR REPLACE FUNCTION validate_user_plan_assignment()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    selected_scope VARCHAR(10);
    selected_owner UUID;
BEGIN
    SELECT scope, owner_account_id
      INTO selected_scope, selected_owner
      FROM plans
     WHERE id = NEW.user_plan_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'User plan does not exist'
            USING ERRCODE = '23503';
    END IF;

    IF selected_scope <> 'user' THEN
        RAISE EXCEPTION 'User requires a user-scope plan'
            USING ERRCODE = '23514';
    END IF;

    IF selected_owner IS NOT NULL
       AND selected_owner <> NEW.account_id THEN
        RAISE EXCEPTION 'Plan belongs to a different account'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_validate_plan ON users;

CREATE TRIGGER users_validate_plan
BEFORE INSERT OR UPDATE OF user_plan_id, account_id ON users
FOR EACH ROW
EXECUTE FUNCTION validate_user_plan_assignment();

-- =========================================
-- 5. Protect predefined plans
-- =========================================

CREATE OR REPLACE FUNCTION protect_predefined_plans()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.is_predefined THEN
        RAISE EXCEPTION 'Predefined plans cannot be modified or deleted'
            USING ERRCODE = '23514';
    END IF;

    IF TG_OP = 'UPDATE' THEN
        NEW.updated_at := now();
        NEW.version := OLD.version + 1;
        RETURN NEW;
    END IF;

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS plans_protect_predefined ON plans;

CREATE TRIGGER plans_protect_predefined
BEFORE UPDATE OR DELETE ON plans
FOR EACH ROW
EXECUTE FUNCTION protect_predefined_plans();

-- =========================================
-- 6. Monthly usage counters
-- =========================================

CREATE TABLE IF NOT EXISTS account_monthly_usage (
    account_id UUID NOT NULL
        REFERENCES accounts(id) ON DELETE RESTRICT,

    usage_month DATE NOT NULL
        CHECK (EXTRACT(DAY FROM usage_month) = 1),

    consumed_units BIGINT NOT NULL DEFAULT 0
        CHECK (consumed_units >= 0),

    PRIMARY KEY (account_id, usage_month)
);

CREATE TABLE IF NOT EXISTS user_monthly_usage (
    user_id UUID NOT NULL
        REFERENCES users(id) ON DELETE RESTRICT,

    usage_month DATE NOT NULL
        CHECK (EXTRACT(DAY FROM usage_month) = 1),

    consumed_units BIGINT NOT NULL DEFAULT 0
        CHECK (consumed_units >= 0),

    PRIMARY KEY (user_id, usage_month)
);

-- =========================================
-- 7. Request history and idempotency
-- =========================================

CREATE TABLE IF NOT EXISTS request_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    account_id UUID NOT NULL
        REFERENCES accounts(id) ON DELETE RESTRICT,

    user_id UUID NOT NULL,

    -- Unique within an account. Reusing the same key must
    -- not consume units a second time.
    request_id VARCHAR(128) NOT NULL
        CHECK (length(btrim(request_id)) BETWEEN 1 AND 128),

    units BIGINT NOT NULL CHECK (units > 0),

    status VARCHAR(10) NOT NULL
        CHECK (status IN ('accepted', 'rejected')),

    rejection_scope VARCHAR(10),
    rejection_rule VARCHAR(30),
    reason TEXT,

    usage_month DATE NOT NULL
        CHECK (EXTRACT(DAY FROM usage_month) = 1),

    -- Snapshot the plan IDs and limits used for this decision.
    account_plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
    user_plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,

    account_monthly_limit BIGINT NOT NULL CHECK (account_monthly_limit > 0),
    account_request_limit BIGINT NOT NULL CHECK (account_request_limit > 0),
    user_monthly_limit BIGINT NOT NULL CHECK (user_monthly_limit > 0),
    user_request_limit BIGINT NOT NULL CHECK (user_request_limit > 0),

    account_used_before BIGINT NOT NULL CHECK (account_used_before >= 0),
    account_used_after BIGINT NOT NULL CHECK (account_used_after >= 0),
    user_used_before BIGINT NOT NULL CHECK (user_used_before >= 0),
    user_used_after BIGINT NOT NULL CHECK (user_used_after >= 0),

    -- Store the original response so retries can return
    -- the same outcome even if usage or plans later change.
    result JSONB NOT NULL
        CHECK (jsonb_typeof(result) = 'object'),

    processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT request_history_account_request_unique
        UNIQUE (account_id, request_id),

    CONSTRAINT request_history_user_account_fk
        FOREIGN KEY (user_id, account_id)
        REFERENCES users(id, account_id)
        ON DELETE RESTRICT,

    CONSTRAINT request_history_decision_consistency CHECK (
        (
            status = 'accepted'
            AND rejection_scope IS NULL
            AND rejection_rule IS NULL
            AND account_used_after = account_used_before + units
            AND user_used_after = user_used_before + units
            AND account_used_after <= account_monthly_limit
            AND user_used_after <= user_monthly_limit
            AND units <= account_request_limit
            AND units <= user_request_limit
        )
        OR
        (
            status = 'rejected'
            AND rejection_scope IN ('account', 'user')
            AND rejection_rule IN (
                'monthly_allowance',
                'max_units_per_request'
            )
            AND account_used_after = account_used_before
            AND user_used_after = user_used_before
        )
    )
);

CREATE INDEX IF NOT EXISTS request_history_account_recent_idx
    ON request_history (account_id, processed_at DESC);

CREATE INDEX IF NOT EXISTS request_history_user_recent_idx
    ON request_history (user_id, processed_at DESC);

-- Request history is append-only to preserve past decisions.
CREATE OR REPLACE FUNCTION prevent_request_history_changes()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Request history is immutable';
END;
$$;

DROP TRIGGER IF EXISTS request_history_immutable ON request_history;

CREATE TRIGGER request_history_immutable
BEFORE UPDATE OR DELETE ON request_history
FOR EACH ROW
EXECUTE FUNCTION prevent_request_history_changes();

-- =========================================
-- 8. Predefined plans
-- =========================================

INSERT INTO plans (
    id, name, scope, owner_account_id,
    monthly_allowance, max_units_per_request, is_predefined
)
VALUES
    (
        '10000000-0000-4000-8000-000000000001',
        'Starter', 'account', NULL, 10000, 100, TRUE
    ),
    (
        '10000000-0000-4000-8000-000000000002',
        'Pro', 'account', NULL, 100000, 1000, TRUE
    ),
    (
        '10000000-0000-4000-8000-000000000003',
        'Basic', 'user', NULL, 1000, 20, TRUE
    ),
    (
        '10000000-0000-4000-8000-000000000004',
        'Premium', 'user', NULL, 10000, 100, TRUE
    )
ON CONFLICT (id) DO NOTHING;

COMMIT;
