import { pool } from "../config/database.js";

export interface PlanRecord {
  id: string;
  name: string;
  scope: "account" | "user";
  monthlyAllowance: string;
  maxUnitsPerRequest: string;
  isPredefined: boolean;
  version: number;
}

export interface CreatePlanInput {
  name: string;
  scope: "account" | "user";
  monthlyAllowance: number;
  maxUnitsPerRequest: number;
}

export interface UpdatePlanInput {
  name?: string | undefined;
  monthlyAllowance?: number | undefined;
  maxUnitsPerRequest?: number | undefined;
}

const PLAN_COLUMNS = `
  id,
  name,
  scope,
  monthly_allowance::text AS "monthlyAllowance",
  max_units_per_request::text AS "maxUnitsPerRequest",
  is_predefined AS "isPredefined",
  version
`;

export async function listPlansForAccount(
  accountId: string,
): Promise<PlanRecord[]> {
  const result = await pool.query<PlanRecord>(
    `
      SELECT ${PLAN_COLUMNS}
      FROM plans
      WHERE is_predefined = TRUE
         OR owner_account_id = $1
      ORDER BY scope, monthly_allowance, name
    `,
    [accountId],
  );

  return result.rows;
}

export async function createCustomPlan(
  accountId: string,
  input: CreatePlanInput,
): Promise<PlanRecord> {
  const result = await pool.query<PlanRecord>(
    `
      INSERT INTO plans (
        name,
        scope,
        owner_account_id,
        monthly_allowance,
        max_units_per_request,
        is_predefined
      )
      VALUES ($1, $2, $3, $4, $5, FALSE)
      RETURNING ${PLAN_COLUMNS}
    `,
    [
      input.name,
      input.scope,
      accountId,
      input.monthlyAllowance,
      input.maxUnitsPerRequest,
    ],
  );

  return result.rows[0]!;
}

export async function updateCustomPlan(
  accountId: string,
  planId: string,
  input: UpdatePlanInput,
): Promise<PlanRecord | null> {
  const result = await pool.query<PlanRecord>(
    `
      UPDATE plans
      SET
        name = COALESCE($3::varchar, name),
        monthly_allowance =
          COALESCE($4::bigint, monthly_allowance),
        max_units_per_request =
          COALESCE($5::bigint, max_units_per_request)
      WHERE id = $1
        AND owner_account_id = $2
        AND is_predefined = FALSE
      RETURNING ${PLAN_COLUMNS}
    `,
    [
      planId,
      accountId,
      input.name ?? null,
      input.monthlyAllowance ?? null,
      input.maxUnitsPerRequest ?? null,
    ],
  );

  return result.rows[0] ?? null;
}
