import type { Request, Response } from "express";
import { z } from "zod";
import type { AccountContext } from "../types/account.js";
import {
  changeUserPlan,
  createUser,
  listUsersForAccount,
} from "../repositories/user-repository.js";

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

function serializeUser(user: {
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
}) {
  return {
    id: user.id,
    externalUserId: user.externalUserId,
    displayName: user.displayName,
    createdAt: user.createdAt,
    plan: {
      id: user.userPlanId,
      name: user.planName,
      monthlyAllowance: Number(user.monthlyAllowance),
      maxUnitsPerRequest: Number(user.maxUnitsPerRequest),
    },
    currentMonthUsage: {
      consumedUnits: Number(user.consumedUnits),
      remainingUnits: Number(user.remainingUnits),
    },
  };
}

const createUserSchema = z.object({
  externalUserId: z.string().trim().min(1).max(128),
  displayName: z.string().trim().min(1).max(120),
  planId: z.string().uuid().optional(),
}).strict();

const changePlanSchema = z.object({
  planId: z.string().uuid(),
}).strict();

export async function listUsersHandler(
  _req: Request,
  res: Response,
): Promise<void> {
  const accountId = accountIdFromResponse(res);
  if (!accountId) {
    res.status(401).json({ error: { code: "UNAUTHENTICATED" } });
    return;
  }

  const users = await listUsersForAccount(accountId);
  res.status(200).json({ users: users.map(serializeUser) });
}

export async function createUserHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const accountId = accountIdFromResponse(res);
  if (!accountId) {
    res.status(401).json({ error: { code: "UNAUTHENTICATED" } });
    return;
  }

  const parsed = createUserSchema.safeParse(req.body);
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
    const input = {
      externalUserId: parsed.data.externalUserId,
      displayName: parsed.data.displayName,
      ...(parsed.data.planId ? { planId: parsed.data.planId } : {}),
    };

    const user = await createUser(accountId, input);

    if (!user) {
      res.status(400).json({
        error: {
          code: "INVALID_USER_PLAN",
          message: "The selected user plan is unavailable to this account.",
        },
      });
      return;
    }

    res.status(201).json({ user: serializeUser(user) });
  } catch (error) {
    if (postgresErrorCode(error) === "23505") {
      res.status(409).json({
        error: {
          code: "USER_ALREADY_EXISTS",
          message: "This external user ID is already registered.",
        },
      });
      return;
    }

    console.error("User creation failed:", error);
    res.status(500).json({
      error: { code: "INTERNAL_ERROR" },
    });
  }
}

export async function changeUserPlanHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const accountId = accountIdFromResponse(res);
  if (!accountId) {
    res.status(401).json({ error: { code: "UNAUTHENTICATED" } });
    return;
  }

  const userIdResult = z.string().uuid().safeParse(req.params.userId);
  const parsed = changePlanSchema.safeParse(req.body);

  if (!userIdResult.success || !parsed.success) {
    res.status(400).json({
      error: { code: "VALIDATION_ERROR" },
    });
    return;
  }

  const user = await changeUserPlan(
    accountId,
    userIdResult.data,
    parsed.data.planId,
  );

  if (!user) {
    res.status(404).json({
      error: {
        code: "USER_OR_PLAN_NOT_FOUND",
        message: "The user or an assignable plan was not found for this account.",
      },
    });
    return;
  }

  res.status(200).json({ user: serializeUser(user) });
}
