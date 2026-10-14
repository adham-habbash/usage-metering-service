import { pool } from "../config/database.js";

interface AccountUsageRow {
  id: string;
  name: string;
  planName: string;
  monthlyAllowance: string;
  maxUnitsPerRequest: string;
  consumedUnits: string;
  remainingUnits: string | null;
}

interface UserUsageRow {
  id: string;
  externalUserId: string;
  displayName: string;
  planId: string;
  planName: string;
  monthlyAllowance: string;
  maxUnitsPerRequest: string;
  consumedUnits: string;
  remainingUnits: string | null;
}

export interface UsageReport {
  account: AccountUsageRow;
  users: UserUsageRow[];
}

export async function getUsageReport(
  accountId: string,
  monthStart: string,
): Promise<UsageReport | null> {
  const [accountResult, usersResult] = await Promise.all([
    pool.query<AccountUsageRow>(
      `
        SELECT
          a.id,
          a.name,
          p.name AS "planName",
          p.monthly_allowance::text AS "monthlyAllowance",
          p.max_units_per_request::text AS "maxUnitsPerRequest",
          COALESCE(mu.consumed_units, 0)::text AS "consumedUnits",
          CASE
            WHEN $2::date =
              date_trunc(
                'month',
                CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
              )::date
            THEN GREATEST(
              p.monthly_allowance - COALESCE(mu.consumed_units, 0),
              0
            )::text
            ELSE NULL
          END AS "remainingUnits"
        FROM accounts a
        JOIN plans p ON p.id = a.account_plan_id
        LEFT JOIN account_monthly_usage mu
          ON mu.account_id = a.id
         AND mu.usage_month = $2::date
        WHERE a.id = $1
      `,
      [accountId, monthStart],
    ),
    pool.query<UserUsageRow>(
      `
        SELECT
          u.id,
          u.external_user_id AS "externalUserId",
          u.display_name AS "displayName",
          p.id AS "planId",
          p.name AS "planName",
          p.monthly_allowance::text AS "monthlyAllowance",
          p.max_units_per_request::text AS "maxUnitsPerRequest",
          COALESCE(mu.consumed_units, 0)::text AS "consumedUnits",
          CASE
            WHEN $2::date =
              date_trunc(
                'month',
                CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
              )::date
            THEN GREATEST(
              p.monthly_allowance - COALESCE(mu.consumed_units, 0),
              0
            )::text
            ELSE NULL
          END AS "remainingUnits"
        FROM users u
        JOIN plans p ON p.id = u.user_plan_id
        LEFT JOIN user_monthly_usage mu
          ON mu.user_id = u.id
         AND mu.usage_month = $2::date
        WHERE u.account_id = $1
        ORDER BY u.created_at DESC, u.id
      `,
      [accountId, monthStart],
    ),
  ]);

  const account = accountResult.rows[0];

  if (!account) {
    return null;
  }

  return {
    account,
    users: usersResult.rows,
  };
}

export interface HistoryRow {
  id: string;
  requestId: string;
  userId: string;
  units: string;
  status: "accepted" | "rejected";
  rejectionScope: "account" | "user" | null;
  rejectionRule: "monthly_allowance" | "max_units_per_request" | null;
  reason: string | null;
  usageMonth: string;
  processedAt: Date;
  accountMonthlyLimit: string;
  accountRequestLimit: string;
  userMonthlyLimit: string;
  userRequestLimit: string;
  result: Record<string, unknown>;
}

export interface HistoryPage {
  items: HistoryRow[];
  total: number;
}

export async function getHistoryPage(
  accountId: string,
  monthStart: string,
  userId: string | undefined,
  limit: number,
  offset: number,
): Promise<HistoryPage> {
  const [countResult, rowsResult] = await Promise.all([
    pool.query<{ total: string }>(
      `
        SELECT COUNT(*)::text AS total
        FROM request_history
        WHERE account_id = $1
          AND usage_month = $2::date
          AND ($3::uuid IS NULL OR user_id = $3::uuid)
      `,
      [accountId, monthStart, userId ?? null],
    ),
    pool.query<HistoryRow>(
      `
        SELECT
          id,
          request_id AS "requestId",
          user_id AS "userId",
          units::text AS units,
          status,
          rejection_scope AS "rejectionScope",
          rejection_rule AS "rejectionRule",
          reason,
          usage_month::text AS "usageMonth",
          processed_at AS "processedAt",
          account_monthly_limit::text AS "accountMonthlyLimit",
          account_request_limit::text AS "accountRequestLimit",
          user_monthly_limit::text AS "userMonthlyLimit",
          user_request_limit::text AS "userRequestLimit",
          result
        FROM request_history
        WHERE account_id = $1
          AND usage_month = $2::date
          AND ($3::uuid IS NULL OR user_id = $3::uuid)
        ORDER BY processed_at DESC, id DESC
        LIMIT $4 OFFSET $5
      `,
      [accountId, monthStart, userId ?? null, limit, offset],
    ),
  ]);

  return {
    items: rowsResult.rows,
    total: Number(countResult.rows[0]?.total ?? "0"),
  };
}
