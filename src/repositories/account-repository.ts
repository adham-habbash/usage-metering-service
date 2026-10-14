import { pool } from "../config/database.js";
import type { AccountContext } from "../types/account.js";

interface CreateAccountInput {
  name: string;
  apiKeyHash: string;
  apiKeyPrefix: string;
}

const ACCOUNT_SELECT = `
  SELECT
    a.id,
    a.name,
    a.created_at AS "createdAt",
    a.account_plan_id AS "accountPlanId",
    p.name AS "accountPlanName",
    p.monthly_allowance::text AS "monthlyAllowance",
    p.max_units_per_request::text AS "maxUnitsPerRequest"
  FROM accounts a
  JOIN plans p ON p.id = a.account_plan_id
`;

export async function insertAccount(
  input: CreateAccountInput,
): Promise<AccountContext | null> {
  const result = await pool.query<AccountContext>(
    `
      WITH inserted AS (
        INSERT INTO accounts (
          name,
          api_key_hash,
          api_key_prefix,
          account_plan_id
        )
        SELECT $1, $2, $3, p.id
        FROM plans p
        WHERE p.name = 'Starter'
          AND p.scope = 'account'
          AND p.is_predefined = TRUE
        RETURNING id, name, account_plan_id, created_at
      )
      SELECT
        i.id,
        i.name,
        i.created_at AS "createdAt",
        i.account_plan_id AS "accountPlanId",
        p.name AS "accountPlanName",
        p.monthly_allowance::text AS "monthlyAllowance",
        p.max_units_per_request::text AS "maxUnitsPerRequest"
      FROM inserted i
      JOIN plans p ON p.id = i.account_plan_id
    `,
    [input.name, input.apiKeyHash, input.apiKeyPrefix],
  );

  return result.rows[0] ?? null;
}

export async function findAccountByApiKeyHash(
  apiKeyHash: string,
): Promise<AccountContext | null> {
  const result = await pool.query<AccountContext>(
    `${ACCOUNT_SELECT} WHERE a.api_key_hash = $1`,
    [apiKeyHash],
  );

  return result.rows[0] ?? null;
}

export async function updateAccountPlan(
  accountId: string,
  planId: string,
): Promise<AccountContext | null> {
  const result = await pool.query<AccountContext>(
    `
      WITH changed AS (
        UPDATE accounts a
        SET account_plan_id = p.id
        FROM plans p
        WHERE a.id = $1
          AND p.id = $2
          AND p.scope = 'account'
          AND (
            p.is_predefined = TRUE
            OR p.owner_account_id = a.id
          )
        RETURNING
          a.id,
          a.name,
          a.created_at AS "createdAt",
          a.account_plan_id AS "accountPlanId"
      )
      SELECT
        c.id,
        c.name,
        c."createdAt",
        c."accountPlanId",
        p.name AS "accountPlanName",
        p.monthly_allowance::text AS "monthlyAllowance",
        p.max_units_per_request::text AS "maxUnitsPerRequest"
      FROM changed c
      JOIN plans p ON p.id = c."accountPlanId"
    `,
    [accountId, planId],
  );

  return result.rows[0] ?? null;
}
