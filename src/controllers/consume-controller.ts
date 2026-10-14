import type { Request, Response } from "express";
import { z } from "zod";
import type { AccountContext } from "../types/account.js";
import {
  consumeUnits,
  ConsumptionUserNotFoundError,
  IdempotencyConflictError,
} from "../services/consumption-service.js";

const consumeSchema = z.object({
  userId: z.string().uuid(),
  units: z.number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER),
  requestId: z.string().trim().min(1).max(128),
}).strict();

export async function consumeHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const account = res.locals.account as AccountContext | undefined;

  if (!account) {
    res.status(401).json({
      error: { code: "UNAUTHENTICATED" },
    });
    return;
  }

  const parsed = consumeSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Provide a valid userId, positive integer units, and requestId.",
        details: parsed.error.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      },
    });
    return;
  }

  try {
    const decision = await consumeUnits(account.id, parsed.data);

    // HTTP 200 means the decision was evaluated and recorded.
    // The JSON "accepted" field tells the caller whether consumption passed.
    res.status(200).json(decision);
  } catch (error) {
    if (error instanceof ConsumptionUserNotFoundError) {
      res.status(404).json({
        error: {
          code: "USER_NOT_FOUND",
          message: "The specified user was not found in this account.",
        },
      });
      return;
    }

    if (error instanceof IdempotencyConflictError) {
      res.status(409).json({
        error: {
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "This requestId was already used with different input.",
        },
      });
      return;
    }

    console.error(
      "Unit consumption failed:",
      error instanceof Error ? error.message : "Unknown error",
    );

    res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "The usage decision could not be completed.",
      },
    });
  }
}
