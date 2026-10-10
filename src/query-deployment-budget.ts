export interface DeploymentBudget {
  totalMaxConcurrent: number;
  maxInstances: number;
}
export interface QueryBudgetPlan extends DeploymentBudget {
  allocationMode: "static-per-process";
  perProcessMaxConcurrent: number;
  plannedMaxConcurrent: number;
  plannedMaxQueued: number;
  observedProcessCount: null;
}

/** Conservative static allocation; it neither discovers nor leases API instances. */
export function resolveQueryDeploymentBudget(options: {
  maxConcurrent: number; maxQueued: number; deploymentBudget?: DeploymentBudget | undefined;
}): { maxConcurrent: number; deploymentBudget: QueryBudgetPlan | undefined } {
  const budget = options.deploymentBudget;
  if (!budget) return { maxConcurrent: options.maxConcurrent, deploymentBudget: undefined };
  if (!Number.isSafeInteger(budget.totalMaxConcurrent) || !Number.isSafeInteger(budget.maxInstances) ||
      budget.maxInstances < 1 || budget.totalMaxConcurrent < budget.maxInstances) {
    throw new Error("Deployment query budget must allocate at least one slot per planned API instance.");
  }
  const maxConcurrent = Math.min(options.maxConcurrent, Math.floor(budget.totalMaxConcurrent / budget.maxInstances));
  return { maxConcurrent, deploymentBudget: { ...budget, allocationMode: "static-per-process",
    perProcessMaxConcurrent: maxConcurrent, plannedMaxConcurrent: maxConcurrent * budget.maxInstances,
    plannedMaxQueued: options.maxQueued * budget.maxInstances, observedProcessCount: null } };
}
