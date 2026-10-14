import type { Request, Response } from "express";
import { z } from "zod";
import type { AccountContext } from "../types/account.js";
import {
  createCustomPlan,
  listPlansForAccount,
  updateCustomPlan,
} from "../repositories/plan-repository.js";

function accountIdFromResponse(res: Response): string | undefined {
  return (res.locals.account as AccountContext | undefined)?.id;
}

function postgresErrorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }

  return undefined;
}

function serializePlan(plan: {
  id: string;
  name: string;
  scope: "account" | "user";
  monthlyAllowance: string;
  maxUnitsPerRequest: string;
  isPredefined: boolean;
  version: number;
}) {
  return {
    ...plan,
    monthlyAllowance: Number(plan.monthlyAllowance),
    maxUnitsPerRequest: Number(plan.maxUnitsPerRequest),
  };
}

const limitSchema = z.number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

const createPlanSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scope: z.enum(["account", "user"]),
  monthlyAllowance: limitSchema,
  maxUnitsPerRequest: limitSchema,
}).strict().refine(
  (value) => value.maxUnitsPerRequest <= value.monthlyAllowance,
  {
    path: ["maxUnitsPerRequest"],
    message: "The request limit cannot exceed the monthly allowance.",
  },
);

const updatePlanSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  monthlyAllowance: limitSchema.optional(),
  maxUnitsPerRequest: limitSchema.optional(),
}).strict().refine(
  (value) => Object.keys(value).length > 0,
  { message: "Provide at least one field to update." },
).refine(
  (value) =>
    value.monthlyAllowance === undefined ||
    value.maxUnitsPerRequest === undefined ||
    value.maxUnitsPerRequest <= value.monthlyAllowance,
  {
    path: ["maxUnitsPerRequest"],
    message: "The request limit cannot exceed the monthly allowance.",
  },
);

export async function listPlansHandler(
  _req: Request,
  res: Response,
): Promise<void> {
  const accountId = accountIdFromResponse(res);
  if (!accountId) {
    res.status(401).json({ error: { code: "UNAUTHENTICATED" } });
    return;
  }

  const plans = await listPlansForAccount(accountId);
  res.status(200).json({ plans: plans.map(serializePlan) });
}

export async function createPlanHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const accountId = accountIdFromResponse(res);
  if (!accountId) {
    res.status(401).json({ error: { code: "UNAUTHENTICATED" } });
    return;
  }

  const parsed = createPlanSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        details: parsed.error.issues,
      },
    });
    return;
  }

  try {
    const plan = await createCustomPlan(accountId, parsed.data);
    res.status(201).json({ plan: serializePlan(plan) });
  } catch (error) {
    if (postgresErrorCode(error) === "23505") {
      res.status(409).json({
        error: {
          code: "PLAN_NAME_EXISTS",
          message: "A plan with this name already exists in this scope.",
        },
      });
      return;
    }

    console.error("Plan creation failed:", error);
    res.status(500).json({
      error: { code: "INTERNAL_ERROR" },
    });
  }
}

export async function updatePlanHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const accountId = accountIdFromResponse(res);
  if (!accountId) {
    res.status(401).json({ error: { code: "UNAUTHENTICATED" } });
    return;
  }

  const idResult = z.string().uuid().safeParse(req.params.planId);
  const parsed = updatePlanSchema.safeParse(req.body);

  if (!idResult.success || !parsed.success) {
    res.status(400).json({
      error: { code: "VALIDATION_ERROR" },
    });
    return;
  }

  try {
    const plan = await updateCustomPlan(
      accountId,
      idResult.data,
      parsed.data,
    );

    if (!plan) {
      res.status(404).json({
        error: {
          code: "PLAN_NOT_FOUND",
          message: "The custom plan was not found for this account.",
        },
      });
      return;
    }

    res.status(200).json({ plan: serializePlan(plan) });
  } catch (error) {
    const code = postgresErrorCode(error);

    if (code === "23505") {
      res.status(409).json({ error: { code: "PLAN_NAME_EXISTS" } });
      return;
    }

    if (code === "23514") {
      res.status(400).json({
        error: {
          code: "INVALID_PLAN_LIMITS",
          message: "The request limit cannot exceed the monthly allowance.",
        },
      });
      return;
    }

    console.error("Plan update failed:", error);
    res.status(500).json({
      error: { code: "INTERNAL_ERROR" },
    });
  }
}
