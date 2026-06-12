import { createAiBudget } from "@defnotean/shared/aiBudget";

const budget = createAiBudget();

export const _setClock = budget._setClock;
export const _reset = budget._reset;
export const _countSize = budget._countSize;
export const _notifySize = budget._notifySize;
export const budgetEnabled = budget.budgetEnabled;
export const checkBudget = budget.checkBudget;
export const incrementBudget = budget.incrementBudget;
export const shouldNotify = budget.shouldNotify;
