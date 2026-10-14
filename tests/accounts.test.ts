import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import app from "../src/app.js";
import { pool } from "../src/config/database.js";

const accountName = `Integration Test ${randomUUID()}`;

let accountApiKey: string | undefined;
let accountId: string | undefined;

describe("Account API", () => {
  it("creates an account and returns a one-time API key", async () => {
    const response = await request(app)
      .post("/api/accounts")
      .send({ name: accountName });

    expect(response.status).toBe(201);
    expect(response.body.account.name).toBe(accountName);
    expect(response.body.account.plan).toMatchObject({
      name: "Starter",
      monthlyAllowance: 10000,
      maxUnitsPerRequest: 100,
    });

    expect(response.body.apiKey).toMatch(/^um_live_[A-Za-z0-9_-]+$/);

    accountApiKey = response.body.apiKey as string;
    accountId = response.body.account.id as string;

    const storedKey = await pool.query<{
      api_key_hash: string;
      api_key_prefix: string;
    }>(
      "SELECT api_key_hash, api_key_prefix FROM accounts WHERE id = $1",
      [accountId],
    );

    expect(storedKey.rows).toHaveLength(1);
    expect(storedKey.rows[0]?.api_key_hash).toBe(
      createHash("sha256").update(accountApiKey).digest("hex"),
    );
    expect(storedKey.rows[0]?.api_key_hash).not.toBe(accountApiKey);
  });

  it("returns account details when the API key is valid", async () => {
    expect(accountApiKey).toBeDefined();

    const response = await request(app)
      .get("/api/account")
      .set("x-api-key", accountApiKey as string);

    expect(response.status).toBe(200);
    expect(response.body.account.id).toBe(accountId);
    expect(response.body.account.plan.name).toBe("Starter");
  });

  it("rejects a missing API key", async () => {
    const response = await request(app).get("/api/account");

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("API_KEY_REQUIRED");
  });

  it("rejects an invalid API key", async () => {
    const response = await request(app)
      .get("/api/account")
      .set("x-api-key", "um_live_not_a_real_key");

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("INVALID_API_KEY");
  });

  it("rejects an invalid account name", async () => {
    const response = await request(app)
      .post("/api/accounts")
      .send({ name: "   " });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  afterAll(async () => {
    try {
      await pool.query(
        "DELETE FROM accounts WHERE name = $1",
        [accountName],
      );
    } finally {
      await pool.end();
    }
  });
});
