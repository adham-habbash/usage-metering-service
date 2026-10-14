import { createHash } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { findAccountByApiKeyHash } from "../repositories/account-repository.js";

export async function authenticateAccount(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const apiKey = req.header("x-api-key");

  if (!apiKey) {
    res.status(401).json({
      error: {
        code: "API_KEY_REQUIRED",
        message: "Provide an API key using the x-api-key header.",
      },
    });
    return;
  }

  if (!apiKey.startsWith("um_live_") || apiKey.length > 100) {
    res.status(401).json({
      error: {
        code: "INVALID_API_KEY",
        message: "The API key is invalid.",
      },
    });
    return;
  }

  const apiKeyHash = createHash("sha256")
    .update(apiKey)
    .digest("hex");

  try {
    const account = await findAccountByApiKeyHash(apiKeyHash);

    if (!account) {
      res.status(401).json({
        error: {
          code: "INVALID_API_KEY",
          message: "The API key is invalid.",
        },
      });
      return;
    }

    res.locals.account = account;
    next();
  } catch (error) {
    console.error(
      "API key verification failed:",
      error instanceof Error ? error.message : "Unknown error",
    );

    res.status(503).json({
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Account authentication is temporarily unavailable.",
      },
    });
  }
}
