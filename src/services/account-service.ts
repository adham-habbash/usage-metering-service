import { createHash, randomBytes } from "node:crypto";
import { insertAccount } from "../repositories/account-repository.js";

export class DefaultPlanUnavailableError extends Error {
  constructor() {
    super("The predefined Starter account plan is unavailable.");
    this.name = "DefaultPlanUnavailableError";
  }
}

export async function provisionAccount(name: string) {
  const apiKey = `um_live_${randomBytes(32).toString("base64url")}`;

  const apiKeyHash = createHash("sha256")
    .update(apiKey)
    .digest("hex");

  const account = await insertAccount({
    name,
    apiKeyHash,
    apiKeyPrefix: apiKey.slice(0, 16),
  });

  if (!account) {
    throw new DefaultPlanUnavailableError();
  }

  return { account, apiKey };
}
