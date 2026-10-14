import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import app from "../src/app.js";
import { pool } from "../src/config/database.js";

const suffix = randomUUID();

const accountName = `Consumption Test ${suffix}`;

let apiKey = "";
let accountId = "";
let accountPlanId = "";
let limitedUserPlanId = "";
let limitedUserId = "";
let standardUserId = "";

describe("Consumption engine", () => {
  it("creates isolated fixtures with restrictive test quotas", async () => {
    const accountResponse = await request(app)
      .post("/api/accounts")
      .send({ name: accountName });

    expect(accountResponse.status).toBe(201);

    apiKey = accountResponse.body.apiKey as string;
    accountId = accountResponse.body.account.id as string;

    const accountPlanResponse = await request(app)
      .post("/api/plans")
      .set("x-api-key", apiKey)
      .send({
        name: `Limited Account ${suffix}`,
        scope: "account",
        monthlyAllowance: 10,
        maxUnitsPerRequest: 10,
      });

    expect(accountPlanResponse.status).toBe(201);
    accountPlanId = accountPlanResponse.body.plan.id as string;

    const changeAccountResponse = await request(app)
      .patch("/api/account/plan")
      .set("x-api-key", apiKey)
      .send({ planId: accountPlanId });

    expect(changeAccountResponse.status).toBe(200);

    const userPlanResponse = await request(app)
      .post("/api/plans")
      .set("x-api-key", apiKey)
      .send({
        name: `Limited User ${suffix}`,
        scope: "user",
        monthlyAllowance: 8,
        maxUnitsPerRequest: 5,
      });

    expect(userPlanResponse.status).toBe(201);
    limitedUserPlanId = userPlanResponse.body.plan.id as string;

    const limitedUserResponse = await request(app)
      .post("/api/users")
      .set("x-api-key", apiKey)
      .send({
        externalUserId: `limited-${suffix}`,
        displayName: "Limited User",
        planId: limitedUserPlanId,
      });

    expect(limitedUserResponse.status).toBe(201);
    limitedUserId = limitedUserResponse.body.user.id as string;

    const standardUserResponse = await request(app)
      .post("/api/users")
      .set("x-api-key", apiKey)
      .send({
        externalUserId: `standard-${suffix}`,
        displayName: "Standard User",
      });

    expect(standardUserResponse.status).toBe(201);
    expect(standardUserResponse.body.user.plan.name).toBe("Basic");

    standardUserId = standardUserResponse.body.user.id as string;
  });

  it("accepts consumption and makes identical retries idempotent", async () => {
    const payload = {
      userId: limitedUserId,
      units: 4,
      requestId: `retry-${suffix}`,
    };

    const first = await request(app)
      .post("/api/consume")
      .set("x-api-key", apiKey)
      .send(payload);

    expect(first.status).toBe(200);
    expect(first.body.accepted).toBe(true);
    expect(first.body.usage.account.consumedUnits).toBe(4);
    expect(first.body.usage.user.consumedUnits).toBe(4);

    const retry = await request(app)
      .post("/api/consume")
      .set("x-api-key", apiKey)
      .send(payload);

    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);

    const conflictingRetry = await request(app)
      .post("/api/consume")
      .set("x-api-key", apiKey)
      .send({
        ...payload,
        units: 3,
      });

    expect(conflictingRetry.status).toBe(409);
    expect(conflictingRetry.body.error.code).toBe(
      "IDEMPOTENCY_KEY_REUSED",
    );

    const counters = await pool.query<{
      accountUsed: string;
      userUsed: string;
    }>(
      `
        SELECT
          (
            SELECT consumed_units::text
            FROM account_monthly_usage
            WHERE account_id = $1
              AND usage_month = date_trunc(
                'month',
                CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
              )::date
          ) AS "accountUsed",
          (
            SELECT consumed_units::text
            FROM user_monthly_usage
            WHERE user_id = $2
              AND usage_month = date_trunc(
                'month',
                CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
              )::date
          ) AS "userUsed"
      `,
      [accountId, limitedUserId],
    );

    expect(counters.rows[0]?.accountUsed).toBe("4");
    expect(counters.rows[0]?.userUsed).toBe("4");
  });

  it("rejects a request exceeding the user's per-request limit", async () => {
    const response = await request(app)
      .post("/api/consume")
      .set("x-api-key", apiKey)
      .send({
        userId: limitedUserId,
        units: 6,
        requestId: `user-request-limit-${suffix}`,
      });

    expect(response.status).toBe(200);
    expect(response.body.accepted).toBe(false);
    expect(response.body.rejection).toMatchObject({
      scope: "user",
      rule: "max_units_per_request",
    });

    expect(response.body.usage.account.consumedUnits).toBe(4);
    expect(response.body.usage.user.consumedUnits).toBe(4);
  });

  it("rejects a request exceeding the user's monthly allowance", async () => {
    const response = await request(app)
      .post("/api/consume")
      .set("x-api-key", apiKey)
      .send({
        userId: limitedUserId,
        units: 5,
        requestId: `user-monthly-limit-${suffix}`,
      });

    expect(response.status).toBe(200);
    expect(response.body.accepted).toBe(false);
    expect(response.body.rejection).toMatchObject({
      scope: "user",
      rule: "monthly_allowance",
    });

    expect(response.body.usage.account.consumedUnits).toBe(4);
    expect(response.body.usage.user.consumedUnits).toBe(4);
  });

  it("rejects consumption that would exceed the shared account allowance", async () => {
    const response = await request(app)
      .post("/api/consume")
      .set("x-api-key", apiKey)
      .send({
        userId: standardUserId,
        units: 7,
        requestId: `account-monthly-limit-${suffix}`,
      });

    expect(response.status).toBe(200);
    expect(response.body.accepted).toBe(false);
    expect(response.body.rejection).toMatchObject({
      scope: "account",
      rule: "monthly_allowance",
    });

    expect(response.body.usage.account.consumedUnits).toBe(4);
    expect(response.body.usage.account.remainingUnits).toBe(6);
  });

  it("does not allow concurrent requests to exceed the account quota", async () => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        request(app)
          .post("/api/consume")
          .set("x-api-key", apiKey)
          .send({
            userId: standardUserId,
            units: 2,
            requestId: `concurrent-${suffix}-${index}`,
          }),
      ),
    );

    for (const response of responses) {
      expect(response.status).toBe(200);
    }

    const accepted = responses.filter(
      (response) => response.body.accepted === true,
    );

    const rejected = responses.filter(
      (response) => response.body.accepted === false,
    );

    // Four units were already consumed. Exactly six remain.
    // Three requests of two units should succeed; seven should fail.
    expect(accepted).toHaveLength(3);
    expect(rejected).toHaveLength(7);

    const totals = await pool.query<{
      accountUsed: string;
      summedUserUsage: string;
    }>(
      `
        SELECT
          (
            SELECT consumed_units::text
            FROM account_monthly_usage
            WHERE account_id = $1
              AND usage_month = date_trunc(
                'month',
                CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
              )::date
          ) AS "accountUsed",
          (
            SELECT COALESCE(SUM(consumed_units), 0)::text
            FROM user_monthly_usage mu
            JOIN users u ON u.id = mu.user_id
            WHERE u.account_id = $1
              AND mu.usage_month = date_trunc(
                'month',
                CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
              )::date
          ) AS "summedUserUsage"
      `,
      [accountId],
    );

    expect(totals.rows[0]?.accountUsed).toBe("10");
    expect(totals.rows[0]?.summedUserUsage).toBe("10");
  });

  it("reports the current account and user balances", async () => {
    const response = await request(app)
      .get("/api/usage")
      .set("x-api-key", apiKey);

    expect(response.status).toBe(200);
    expect(response.body.currentMonth).toBe(true);
    expect(response.body.account.consumedUnits).toBe(10);
    expect(response.body.account.remainingUnits).toBe(0);

    const limitedUser = response.body.users.find(
      (user: { id: string }) => user.id === limitedUserId,
    );

    const standardUser = response.body.users.find(
      (user: { id: string }) => user.id === standardUserId,
    );

    expect(limitedUser.consumedUnits).toBe(4);
    expect(limitedUser.remainingUnits).toBe(4);
    expect(standardUser.consumedUnits).toBe(6);
    expect(standardUser.remainingUnits).toBe(994);
  });

  it("does not invent remaining balances for previous months", async () => {
    const now = new Date();
    const previousMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
    ).toISOString().slice(0, 7);

    const response = await request(app)
      .get(`/api/usage?month=${previousMonth}`)
      .set("x-api-key", apiKey);

    expect(response.status).toBe(200);
    expect(response.body.currentMonth).toBe(false);
    expect(response.body.account.consumedUnits).toBe(0);
    expect(response.body.account.remainingUnits).toBeNull();
  });

  it("returns paginated request history and preserves decision details", async () => {
    const month = new Date().toISOString().slice(0, 7);

    const response = await request(app)
      .get(`/api/history?month=${month}&page=1&pageSize=2`)
      .set("x-api-key", apiKey);

    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(2);
    expect(response.body.pagination.page).toBe(1);
    expect(response.body.pagination.pageSize).toBe(2);
    expect(response.body.pagination.total).toBeGreaterThanOrEqual(14);

    const item = response.body.items[0];

    expect(item.requestId).toBeDefined();
    expect(["accepted", "rejected"]).toContain(item.status);
    expect(item.limitsAtDecision.accountMonthlyAllowance).toBe(10);
    expect(item.decision).toBeDefined();
  });

  it("rejects reporting requests without an API key", async () => {
    const usageResponse = await request(app).get("/api/usage");
    const historyResponse = await request(app).get("/api/history");

    expect(usageResponse.status).toBe(401);
    expect(historyResponse.status).toBe(401);
  });

  it("rejects invalid reporting query parameters", async () => {
    const usageResponse = await request(app)
      .get("/api/usage?month=not-a-month")
      .set("x-api-key", apiKey);

    const historyResponse = await request(app)
      .get("/api/history?page=0")
      .set("x-api-key", apiKey);

    expect(usageResponse.status).toBe(400);
    expect(historyResponse.status).toBe(400);
  });

});

afterAll(async () => {
  // Request history is append-only in this schema. These uniquely named
  // integration fixtures intentionally retain their audit records.
  await pool.end();
});
