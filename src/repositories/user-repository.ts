import { pool } from "../config/database.js";

export interface UserRecord {
  id: string;
  externalUserId: string;
  displayName: string;
  createdAt: Date;
  userPlanId: string;
  planName: string;
  monthlyAllowance: string;
  maxUnitsPerRequest: string;
  consumedUnits: string;
  remainingUnits: string;
}

export interface CreateUserInput {
  externalUserId: string;
  displayName: string;
  planId?: string;
}

const USER_SELECT = `
  SELECT
    u.id,
    u.external_user_id AS "externalUserId",
    u.display_name AS "displayName",
    u.created_at AS "createdAt",
    p.id AS "userPlanId",
    p.name AS "planName",
    p.monthly_allowance::text AS "monthlyAllowance",
    p.max_units_per_request::text AS "maxUnitsPerRequest",
    COALESCE(mu.consumed_units, 0)::text AS "consumedUnits",
    GREATEST(
      p.monthly_allowance - COALESCE(mu.consumed_units, 0),
      0
    )::text AS "remainingUnits"
  FROM users u
  JOIN plans p ON p.id = u.user_plan_id
  LEFT JOIN user_monthly_usage mu
    ON mu.user_id = u.id
   AND mu.usage_month =
       date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date
`;

export async function listUsersForAccount(
  accountId: string,
): Promise<UserRecord[]> {
  const result = await pool.query<UserRecord>(
    `${USER_SELECT}
     WHERE u.account_id = $1
     ORDER BY u.created_at DESC`,
    [accountId],
  );

  return result.rows;
}

export async function createUser(
  accountId: string,
  input: CreateUserInput,
): Promise<UserRecord | null> {
  const result = await pool.query<UserRecord>(
    `
      WITH chosen_plan AS (
        SELECT id
        FROM plans
        WHERE scope = 'user'
          AND (
            ( $4::uuid IS NULL
              AND name = 'Basic'
              AND is_predefined = TRUE
            )
            OR id = $4::uuid
          )
          AND (
            is_predefined = TRUE
            OR owner_account_id = $1
          )
        LIMIT 1
      ),
      inserted AS (
        INSERT INTO users (
          account_id,
          external_user_id,
          display_name,
          user_plan_id
        )
        SELECT $1, $2, $3, id
        FROM chosen_plan
        RETURNING *
      )
      ${USER_SELECT.replace("FROM users u", "FROM inserted u")}
      WHERE TRUE
    `,
    [
      accountId,
      input.externalUserId,
      input.displayName,
      input.planId ?? null,
    ],
  );

  return result.rows[0] ?? null;
}

export async function changeUserPlan(
  accountId: string,
  userId: string,
  planId: string,
): Promise<UserRecord | null> {
  const result = await pool.query<UserRecord>(
    `
      WITH changed AS (
        UPDATE users u
        SET user_plan_id = p.id
        FROM plans p
        WHERE u.id = $1
          AND u.account_id = $2
          AND p.id = $3
          AND p.scope = 'user'
          AND (
            p.is_predefined = TRUE
            OR p.owner_account_id = $2
          )
        RETURNING u.*
      )
      ${USER_SELECT.replace("FROM users u", "FROM changed u")}
      WHERE TRUE
    `,
    [userId, accountId, planId],
  );

  return result.rows[0] ?? null;
}
