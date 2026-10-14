import type { Request, Response } from "express";
import { z } from "zod";
import {
  updateAccountPlan,
} from "../repositories/account-repository.js";
import type { AccountContext } from "../types/account.js";
import {
  DefaultPlanUnavailableError,
  provisionAccount,
} from "../services/account-service.js";

const createAccountSchema = z.object({
  name: z.string().trim().min(1).max(120),
}).strict();

export async function createAccountHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const parsed = createAccountSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Provide a valid account name.",
        details: parsed.error.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      },
    });
    return;
  }

  try {
    const { account, apiKey } = await provisionAccount(parsed.data.name);

    res.status(201).json({
      account: {
        id: account.id,
        name: account.name,
        createdAt: account.createdAt,
        plan: {
          id: account.accountPlanId,
          name: account.accountPlanName,
          monthlyAllowance: Number(account.monthlyAllowance),
          maxUnitsPerRequest: Number(account.maxUnitsPerRequest),
        },
      },
      apiKey,
      message: "Store this API key securely. It will not be returned again.",
    });
  } catch (error) {
    if (error instanceof DefaultPlanUnavailableError) {
      res.status(503).json({
        error: {
          code: "DEFAULT_PLAN_UNAVAILABLE",
          message: "The account cannot be created right now.",
        },
      });
      return;
    }

    console.error(
      "Account creation failed:",
      error instanceof Error ? error.message : "Unknown error",
    );

    res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "The account could not be created.",
      },
    });
  }
}

export async function changeAccountPlanHandler(
  _req: Request,
  res: Response,
): Promise<void> {
  const account = res.locals.account as AccountContext | undefined;

  if (!account) {
    res.status(401).json({
      error: { code: "UNAUTHENTICATED" },
    });
    return;
  }

  const schema = z.object({
    planId: z.string().uuid(),
  }).strict();

  const parsed = schema.safeParse(_req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Provide a valid planId UUID.",
      },
    });
    return;
  }

  try {
    const updatedAccount = await updateAccountPlan(
      account.id,
      parsed.data.planId,
    );

    if (!updatedAccount) {
      res.status(400).json({
        error: {
          code: "INVALID_ACCOUNT_PLAN",
          message: "The selected plan is not assignable to this account.",
        },
      });
      return;
    }

    res.status(200).json({
      account: {
        id: updatedAccount.id,
        name: updatedAccount.name,
        plan: {
          id: updatedAccount.accountPlanId,
          name: updatedAccount.accountPlanName,
          monthlyAllowance: Number(updatedAccount.monthlyAllowance),
          maxUnitsPerRequest: Number(updatedAccount.maxUnitsPerRequest),
        },
      },
    });
  } catch (error) {
    console.error(
      "Account plan update failed:",
      error instanceof Error ? error.message : "Unknown error",
    );

    res.status(500).json({
      error: { code: "INTERNAL_ERROR" },
    });
  }
}
