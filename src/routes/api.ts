import { Router } from "express";
import {
  createAccountHandler,
  changeAccountPlanHandler,
} from "../controllers/accounts-controller.js";
import {
  listPlansHandler,
  createPlanHandler,
  updatePlanHandler,
} from "../controllers/plans-controller.js";
import {
  listUsersHandler,
  createUserHandler,
  changeUserPlanHandler,
} from "../controllers/users-controller.js";
import { consumeHandler } from "../controllers/consume-controller.js";
import {
  usageReportHandler,
  historyHandler,
} from "../controllers/reporting-controller.js";
import { authenticateAccount } from "../middleware/authenticate-account.js";
import type { AccountContext } from "../types/account.js";

const router = Router();

router.post("/accounts", createAccountHandler);

// All routes below require an account API key.
router.use(authenticateAccount);

router.get("/account", (_req, res) => {
  const account = res.locals.account as AccountContext | undefined;

  if (!account) {
    res.status(401).json({
      error: { code: "UNAUTHENTICATED" },
    });
    return;
  }

  res.status(200).json({
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
  });
});

router.patch("/account/plan", changeAccountPlanHandler);

router.get("/plans", listPlansHandler);
router.post("/plans", createPlanHandler);
router.patch("/plans/:planId", updatePlanHandler);

router.get("/users", listUsersHandler);
router.post("/users", createUserHandler);
router.patch("/users/:userId/plan", changeUserPlanHandler);

router.post("/consume", consumeHandler);

router.get("/usage", usageReportHandler);
router.get("/history", historyHandler);

export default router;
