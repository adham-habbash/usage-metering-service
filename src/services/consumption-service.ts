import { pool } from "../config/database.js";

export interface ConsumeInput {
  userId: string;
  units: number;
  requestId: string;
}

type RejectionScope = "account" | "user";
type RejectionRule = "monthly_allowance" | "max_units_per_request";

interface Rejection {
  scope: RejectionScope;
  rule: RejectionRule;
  message: string;
}

interface UsageLevel {
  consumedUnits: number;
  remainingUnits: number;
  monthlyAllowance: number;
  maxUnitsPerRequest: number;
}

export interface ConsumeDecision {
  accepted: boolean;
  requestId: string;
  userId: string;
  units: number;
  usageMonth: string;
  rejection?: Rejection;
  usage: {
    account: UsageLevel;
    user: UsageLevel;
  };
}

interface PlanLimitsRow {
  accountPlanId: string;
  accountMonthlyAllowance: string;
  accountRequestLimit: string;
  userPlanId: string;
  userMonthlyAllowance: string;
  userRequestLimit: string;
}

interface UsageRow {
  accountUsed: string;
  userUsed: string;
}

interface ExistingRequestRow {
  userId: string;
  units: string;
  result: ConsumeDecision;
}

export class ConsumptionUserNotFoundError extends Error {
  constructor() {
    super("The user does not belong to this account or does not exist.");
    this.name = "ConsumptionUserNotFoundError";
  }
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super("The request ID has already been used with different input.");
    this.name = "IdempotencyConflictError";
  }
}

export async function consumeUnits(
  accountId: string,
  input: ConsumeInput,
): Promise<ConsumeDecision> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Serialize consumption for this account. This protects the shared
    // account quota even when multiple users send requests concurrently.
    const accountResult = await client.query<{ id: string }>(
      "SELECT id FROM accounts WHERE id = $1 FOR UPDATE",
      [accountId],
    );

    if (accountResult.rowCount !== 1) {
      throw new Error("Authenticated account was not found.");
    }

    // Since the account row is locked, requests using the same account
    // cannot race past this idempotency check.
    const existingResult = await client.query<ExistingRequestRow>(
      `
        SELECT
          user_id AS "userId",
          units::text AS units,
          result
        FROM request_history
        WHERE account_id = $1
          AND request_id = $2
      `,
      [accountId, input.requestId],
    );

    const existing = existingResult.rows[0];

    if (existing) {
      if (
        existing.userId !== input.userId ||
        BigInt(existing.units) !== BigInt(input.units)
      ) {
        throw new IdempotencyConflictError();
      }

      await client.query("COMMIT");
      return existing.result;
    }

    // A user ID is only valid inside the account identified by the API key.
    const userResult = await client.query<{ id: string }>(
      `
        SELECT id
        FROM users
        WHERE id = $1 AND account_id = $2
        FOR UPDATE
      `,
      [input.userId, accountId],
    );

    if (userResult.rowCount !== 1) {
      throw new ConsumptionUserNotFoundError();
    }

    // Share-lock both plan records. Plan edits must wait until this
    // decision finishes, so the recorded limits match the applied rules.
    const limitsResult = await client.query<PlanLimitsRow>(
      `
        SELECT
          ap.id AS "accountPlanId",
          ap.monthly_allowance::text AS "accountMonthlyAllowance",
          ap.max_units_per_request::text AS "accountRequestLimit",
          up.id AS "userPlanId",
          up.monthly_allowance::text AS "userMonthlyAllowance",
          up.max_units_per_request::text AS "userRequestLimit"
        FROM accounts a
        JOIN plans ap ON ap.id = a.account_plan_id
        JOIN users u
          ON u.account_id = a.id
         AND u.id = $2
        JOIN plans up ON up.id = u.user_plan_id
        WHERE a.id = $1
        FOR SHARE OF ap, up
      `,
      [accountId, input.userId],
    );

    const limits = limitsResult.rows[0];

    if (!limits) {
      throw new Error("Unable to load the applicable plans.");
    }

    // Determine the UTC calendar month after acquiring the locks.
    const monthResult = await client.query<{ usageMonth: string }>(
      `
        SELECT to_char(
          date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC'),
          'YYYY-MM-DD'
        ) AS "usageMonth"
      `,
    );

    const usageMonth = monthResult.rows[0]?.usageMonth;

    if (!usageMonth) {
      throw new Error("Unable to determine the UTC usage month.");
    }

    const usageResult = await client.query<UsageRow>(
      `
        SELECT
          COALESCE(
            (
              SELECT consumed_units
              FROM account_monthly_usage
              WHERE account_id = $1
                AND usage_month = $3::date
            ),
            0
          )::text AS "accountUsed",
          COALESCE(
            (
              SELECT consumed_units
              FROM user_monthly_usage
              WHERE user_id = $2
                AND usage_month = $3::date
            ),
            0
          )::text AS "userUsed"
      `,
      [accountId, input.userId, usageMonth],
    );

    const usage = usageResult.rows[0];

    if (!usage) {
      throw new Error("Unable to load current usage.");
    }

    const requested = BigInt(input.units);
    const accountUsedBefore = BigInt(usage.accountUsed);
    const userUsedBefore = BigInt(usage.userUsed);

    const accountMonthlyLimit = BigInt(limits.accountMonthlyAllowance);
    const accountRequestLimit = BigInt(limits.accountRequestLimit);
    const userMonthlyLimit = BigInt(limits.userMonthlyAllowance);
    const userRequestLimit = BigInt(limits.userRequestLimit);

    let rejection: Rejection | undefined;

    // Deterministic evaluation order:
    // account request limit, user request limit,
    // account monthly allowance, user monthly allowance.
    if (requested > accountRequestLimit) {
      rejection = {
        scope: "account",
        rule: "max_units_per_request",
        message: "Request exceeds the account plan's per-request limit.",
      };
    } else if (requested > userRequestLimit) {
      rejection = {
        scope: "user",
        rule: "max_units_per_request",
        message: "Request exceeds the user plan's per-request limit.",
      };
    } else if (accountUsedBefore + requested > accountMonthlyLimit) {
      rejection = {
        scope: "account",
        rule: "monthly_allowance",
        message: "The account's monthly allowance would be exceeded.",
      };
    } else if (userUsedBefore + requested > userMonthlyLimit) {
      rejection = {
        scope: "user",
        rule: "monthly_allowance",
        message: "The user's monthly allowance would be exceeded.",
      };
    }

    const accepted = rejection === undefined;

    const accountUsedAfter = accepted
      ? accountUsedBefore + requested
      : accountUsedBefore;

    const userUsedAfter = accepted
      ? userUsedBefore + requested
      : userUsedBefore;

    // Update both counters in this same transaction. If either operation
    // fails, the transaction rolls back and neither counter is changed.
    if (accepted) {
      await client.query(
        `
          INSERT INTO account_monthly_usage (
            account_id, usage_month, consumed_units
          )
          VALUES ($1, $2::date, $3::bigint)
          ON CONFLICT (account_id, usage_month)
          DO UPDATE SET consumed_units =
            account_monthly_usage.consumed_units
            + EXCLUDED.consumed_units
        `,
        [accountId, usageMonth, input.units],
      );

      await client.query(
        `
          INSERT INTO user_monthly_usage (
            user_id, usage_month, consumed_units
          )
          VALUES ($1, $2::date, $3::bigint)
          ON CONFLICT (user_id, usage_month)
          DO UPDATE SET consumed_units =
            user_monthly_usage.consumed_units
            + EXCLUDED.consumed_units
        `,
        [input.userId, usageMonth, input.units],
      );
    }

    const accountRemaining =
      accountMonthlyLimit > accountUsedAfter
        ? accountMonthlyLimit - accountUsedAfter
        : 0n;

    const userRemaining =
      userMonthlyLimit > userUsedAfter
        ? userMonthlyLimit - userUsedAfter
        : 0n;

    const decision: ConsumeDecision = {
      accepted,
      requestId: input.requestId,
      userId: input.userId,
      units: input.units,
      usageMonth,
      ...(rejection ? { rejection } : {}),
      usage: {
        account: {
          consumedUnits: Number(accountUsedAfter),
          remainingUnits: Number(accountRemaining),
          monthlyAllowance: Number(accountMonthlyLimit),
          maxUnitsPerRequest: Number(accountRequestLimit),
        },
        user: {
          consumedUnits: Number(userUsedAfter),
          remainingUnits: Number(userRemaining),
          monthlyAllowance: Number(userMonthlyLimit),
          maxUnitsPerRequest: Number(userRequestLimit),
        },
      },
    };

    // Accepted and rejected decisions are both persisted. The stored
    // response makes identical retries return the original decision.
    await client.query(
      `
        INSERT INTO request_history (
          account_id,
          user_id,
          request_id,
          units,
          status,
          rejection_scope,
          rejection_rule,
          reason,
          usage_month,
          account_plan_id,
          user_plan_id,
          account_monthly_limit,
          account_request_limit,
          user_monthly_limit,
          user_request_limit,
          account_used_before,
          account_used_after,
          user_used_before,
          user_used_after,
          result
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9::date,
          $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb
        )
      `,
      [
        accountId,
        input.userId,
        input.requestId,
        input.units,
        accepted ? "accepted" : "rejected",
        rejection?.scope ?? null,
        rejection?.rule ?? null,
        rejection?.message ?? null,
        usageMonth,
        limits.accountPlanId,
        limits.userPlanId,
        limits.accountMonthlyAllowance,
        limits.accountRequestLimit,
        limits.userMonthlyAllowance,
        limits.userRequestLimit,
        accountUsedBefore.toString(),
        accountUsedAfter.toString(),
        userUsedBefore.toString(),
        userUsedAfter.toString(),
        JSON.stringify(decision),
      ],
    );

    await client.query("COMMIT");
    return decision;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
