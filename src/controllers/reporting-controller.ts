import type { Request, Response } from "express";
import { z } from "zod";
import type { AccountContext } from "../types/account.js";
import {
  getHistoryPage,
  getUsageReport,
} from "../repositories/reporting-repository.js";

const monthSchema = z.string().regex(
  /^\d{4}-(0[1-9]|1[0-2])$/,
  "Month must use YYYY-MM format.",
);

const usageQuerySchema = z.object({
  month: monthSchema.optional(),
}).strict();

const historyQuerySchema = z.object({
  month: monthSchema.optional(),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  userId: z.string().uuid().optional(),
}).strict();

function getAccountId(res: Response): string | undefined {
  return (res.locals.account as AccountContext | undefined)?.id;
}

function serializeUsageValue(value: {
  id: string;
  planName: string;
  monthlyAllowance: string;
  maxUnitsPerRequest: string;
  consumedUnits: string;
  remainingUnits: string | null;
}) {
  return {
    plan: {
      name: value.planName,
      monthlyAllowance: Number(value.monthlyAllowance),
      maxUnitsPerRequest: Number(value.maxUnitsPerRequest),
    },
    consumedUnits: Number(value.consumedUnits),
    remainingUnits:
      value.remainingUnits === null ? null : Number(value.remainingUnits),
  };
}

export async function usageReportHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const accountId = getAccountId(res);

  if (!accountId) {
    res.status(401).json({ error: { code: "UNAUTHENTICATED" } });
    return;
  }

  const parsed = usageQuerySchema.safeParse(req.query);

  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Use an optional month query parameter in YYYY-MM format.",
      },
    });
    return;
  }

  const month = parsed.data.month ?? new Date().toISOString().slice(0, 7);
  const monthStart = `${month}-01`;

  try {
    const report = await getUsageReport(accountId, monthStart);

    if (!report) {
      res.status(404).json({
        error: { code: "ACCOUNT_NOT_FOUND" },
      });
      return;
    }

    res.status(200).json({
      month,
      currentMonth: month === new Date().toISOString().slice(0, 7),
      account: {
        id: report.account.id,
        name: report.account.name,
        ...serializeUsageValue(report.account),
      },
      users: report.users.map((user) => ({
        id: user.id,
        externalUserId: user.externalUserId,
        displayName: user.displayName,
        ...serializeUsageValue(user),
      })),
      historicalUsageNote:
        "For past months, remainingUnits is null because the original plan assignment may have changed. Historical request decisions retain the limits applied when each request was processed.",
    });
  } catch (error) {
    console.error(
      "Usage report failed:",
      error instanceof Error ? error.message : "Unknown error",
    );

    res.status(500).json({
      error: { code: "INTERNAL_ERROR" },
    });
  }
}

export async function historyHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const accountId = getAccountId(res);

  if (!accountId) {
    res.status(401).json({ error: { code: "UNAUTHENTICATED" } });
    return;
  }

  const parsed = historyQuerySchema.safeParse(req.query);

  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message:
          "Use month=YYYY-MM, page>=1, pageSize=1..100, and an optional valid userId.",
      },
    });
    return;
  }

  const month = parsed.data.month ?? new Date().toISOString().slice(0, 7);
  const monthStart = `${month}-01`;
  const { page, pageSize, userId } = parsed.data;

  try {
    const history = await getHistoryPage(
      accountId,
      monthStart,
      userId,
      pageSize,
      (page - 1) * pageSize,
    );

    res.status(200).json({
      month,
      items: history.items.map((item) => ({
        id: item.id,
        requestId: item.requestId,
        userId: item.userId,
        units: Number(item.units),
        status: item.status,
        rejection: item.rejectionRule
          ? {
              scope: item.rejectionScope,
              rule: item.rejectionRule,
              reason: item.reason,
            }
          : null,
        processedAt: item.processedAt,
        limitsAtDecision: {
          accountMonthlyAllowance: Number(item.accountMonthlyLimit),
          accountMaxUnitsPerRequest: Number(item.accountRequestLimit),
          userMonthlyAllowance: Number(item.userMonthlyLimit),
          userMaxUnitsPerRequest: Number(item.userRequestLimit),
        },
        decision: item.result,
      })),
      pagination: {
        page,
        pageSize,
        total: history.total,
        totalPages: Math.ceil(history.total / pageSize),
      },
    });
  } catch (error) {
    console.error(
      "Request history query failed:",
      error instanceof Error ? error.message : "Unknown error",
    );

    res.status(500).json({
      error: { code: "INTERNAL_ERROR" },
    });
  }
}
