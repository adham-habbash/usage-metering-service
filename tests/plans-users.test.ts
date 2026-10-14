import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import app from "../src/app.js";
import { pool } from "../src/config/database.js";

const suffix = randomUUID();

const ownerName = `Owner ${suffix}`;
const otherName = `Other ${suffix}`;

const accountIds: string[] = [];
const customPlanIds: string[] = [];

let ownerKey: string;
let otherKey: string;

let ownerAccountId: string;
let otherAccountId: string;

let userPlanId: string;
let accountPlanId: string;
let ownerUserId: string;
let basicPlanId: string;

describe("Plans, users, and account isolation", () => {
  it("creates two independent accounts", async () => {
    const ownerResponse = await request(app)
      .post("/api/accounts")
      .send({ name: ownerName });

    expect(ownerResponse.status).toBe(201);

    ownerKey = ownerResponse.body.apiKey as string;
    ownerAccountId = ownerResponse.body.account.id as string;
    accountIds.push(ownerAccountId);

    const otherResponse = await request(app)
      .post("/api/accounts")
      .send({ name: otherName });

    expect(otherResponse.status).toBe(201);

    otherKey = otherResponse.body.apiKey as string;
    otherAccountId = otherResponse.body.account.id as string;
    accountIds.push(otherAccountId);
  });

  it("creates account-owned plans of both scopes", async () => {
    const userPlanResponse = await request(app)
      .post("/api/plans")
      .set("x-api-key", ownerKey)
      .send({
        name: `Custom User ${suffix}`,
        scope: "user",
        monthlyAllowance: 750,
        maxUnitsPerRequest: 25,
      });

    expect(userPlanResponse.status).toBe(201);
    expect(userPlanResponse.body.plan.monthlyAllowance).toBe(750);

    userPlanId = userPlanResponse.body.plan.id as string;
    customPlanIds.push(userPlanId);

    const accountPlanResponse = await request(app)
      .post("/api/plans")
      .set("x-api-key", ownerKey)
      .send({
        name: `Custom Account ${suffix}`,
        scope: "account",
        monthlyAllowance: 5000,
        maxUnitsPerRequest: 100,
      });

    expect(accountPlanResponse.status).toBe(201);

    accountPlanId = accountPlanResponse.body.plan.id as string;
    customPlanIds.push(accountPlanId);
  });

  it("shows custom plans only to their owning account", async () => {
    const ownerResponse = await request(app)
      .get("/api/plans")
      .set("x-api-key", ownerKey);

    expect(ownerResponse.status).toBe(200);

    const ownerPlans = ownerResponse.body.plans as Array<{
      id: string;
      name: string;
      scope: string;
      isPredefined: boolean;
    }>;

    expect(ownerPlans.some((plan) => plan.id === userPlanId)).toBe(true);
    expect(ownerPlans.some((plan) => plan.id === accountPlanId)).toBe(true);

    const basicPlan = ownerPlans.find(
      (plan) => plan.name === "Basic" && plan.scope === "user",
    );

    expect(basicPlan).toBeDefined();
    basicPlanId = basicPlan!.id;

    const otherResponse = await request(app)
      .get("/api/plans")
      .set("x-api-key", otherKey);

    expect(otherResponse.status).toBe(200);

    const otherPlans = otherResponse.body.plans as Array<{ id: string }>;

    expect(otherPlans.some((plan) => plan.id === userPlanId)).toBe(false);
    expect(otherPlans.some((plan) => plan.id === accountPlanId)).toBe(false);
  });

  it("prevents another account from editing or assigning an owned plan", async () => {
    const updateResponse = await request(app)
      .patch(`/api/plans/${userPlanId}`)
      .set("x-api-key", otherKey)
      .send({ monthlyAllowance: 999 });

    expect(updateResponse.status).toBe(404);

    const createUserResponse = await request(app)
      .post("/api/users")
      .set("x-api-key", otherKey)
      .send({
        externalUserId: `foreign-${suffix}`,
        displayName: "Foreign Plan Test",
        planId: userPlanId,
      });

    expect(createUserResponse.status).toBe(400);
    expect(createUserResponse.body.error.code).toBe("INVALID_USER_PLAN");
  });

  it("creates a user with the owner's custom plan", async () => {
    const response = await request(app)
      .post("/api/users")
      .set("x-api-key", ownerKey)
      .send({
        externalUserId: `external-${suffix}`,
        displayName: "Demo User",
        planId: userPlanId,
      });

    expect(response.status).toBe(201);
    expect(response.body.user.plan.name).toBe(`Custom User ${suffix}`);

    ownerUserId = response.body.user.id as string;

    expect(response.body.user.currentMonthUsage).toEqual({
      consumedUnits: 0,
      remainingUnits: 750,
    });
  });

  it("does not expose or permit changes to another account's user", async () => {
    const listResponse = await request(app)
      .get("/api/users")
      .set("x-api-key", otherKey);

    expect(listResponse.status).toBe(200);
    expect(listResponse.body.users).toEqual([]);

    const changeResponse = await request(app)
      .patch(`/api/users/${ownerUserId}/plan`)
      .set("x-api-key", otherKey)
      .send({ planId: basicPlanId });

    expect(changeResponse.status).toBe(404);
  });

  it("updates custom plans and switches the account plan", async () => {
    const planResponse = await request(app)
      .patch(`/api/plans/${userPlanId}`)
      .set("x-api-key", ownerKey)
      .send({
        monthlyAllowance: 500,
        maxUnitsPerRequest: 25,
      });

    expect(planResponse.status).toBe(200);
    expect(planResponse.body.plan.monthlyAllowance).toBe(500);
    expect(planResponse.body.plan.version).toBe(2);

    const accountResponse = await request(app)
      .patch("/api/account/plan")
      .set("x-api-key", ownerKey)
      .send({ planId: accountPlanId });

    expect(accountResponse.status).toBe(200);
    expect(accountResponse.body.account.plan.name).toBe(
      `Custom Account ${suffix}`,
    );

    const currentAccount = await request(app)
      .get("/api/account")
      .set("x-api-key", ownerKey);

    expect(currentAccount.status).toBe(200);
    expect(currentAccount.body.account.plan.id).toBe(accountPlanId);
  });

  it("does not permit editing predefined plans", async () => {
    const response = await request(app)
      .patch(`/api/plans/${basicPlanId}`)
      .set("x-api-key", ownerKey)
      .send({ monthlyAllowance: 999 });

    expect(response.status).toBe(404);
  });
});

afterAll(async () => {
  if (accountIds.length === 0) {
    await pool.end();
    return;
  }

  try {
    const ids = accountIds;

    await pool.query(
      `DELETE FROM user_monthly_usage
       WHERE user_id IN (
         SELECT id FROM users WHERE account_id = ANY($1::uuid[])
       )`,
      [ids],
    );

    await pool.query(
      "DELETE FROM users WHERE account_id = ANY($1::uuid[])",
      [ids],
    );

    await pool.query(
      "DELETE FROM account_monthly_usage WHERE account_id = ANY($1::uuid[])",
      [ids],
    );

    // Restore the predefined plan before deleting an owned account plan.
    await pool.query(
      `UPDATE accounts
       SET account_plan_id = (
         SELECT id FROM plans
         WHERE name = 'Starter'
           AND scope = 'account'
           AND is_predefined = TRUE
       )
       WHERE id = ANY($1::uuid[])`,
      [ids],
    );

    await pool.query(
      "DELETE FROM plans WHERE owner_account_id = ANY($1::uuid[])",
      [ids],
    );

    await pool.query(
      "DELETE FROM accounts WHERE id = ANY($1::uuid[])",
      [ids],
    );
  } finally {
    await pool.end();
  }
});
