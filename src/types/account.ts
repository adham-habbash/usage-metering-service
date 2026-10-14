export interface AccountContext {
  id: string;
  name: string;
  createdAt: Date;
  accountPlanId: string;
  accountPlanName: string;
  monthlyAllowance: string;
  maxUnitsPerRequest: string;
}
