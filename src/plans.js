// Subscription plans and what each one allows. Stripe price IDs come from .env;
// a plan without one can't be bought (the free plan never needs one).

const env = (name) => process.env[name] || null;

export const PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    priceUsd: 0,
    apps: 1,
    accountKeys: 1,
    // Messages that reach the AI (Jev) per calendar month (UTC). Keyword, spam and scam
    // checks are free and unlimited; past this the app runs on those alone until the 1st.
    aiChecksPerMonth: 2_000,
    customRules: 3,
    historyDays: 7,
    webhooks: false,
    // /v1/moderate requests per second, per app.
    requestsPerSecond: 5,
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    priceUsd: 5,
    stripePriceId: env('STRIPE_PRICE_STARTER'),
    apps: 3,
    accountKeys: 3,
    aiChecksPerMonth: 30_000,
    customRules: 15,
    historyDays: 30,
    webhooks: true,
    requestsPerSecond: 20,
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceUsd: 20,
    stripePriceId: env('STRIPE_PRICE_PRO'),
    apps: 15,
    accountKeys: 10,
    aiChecksPerMonth: 200_000,
    customRules: 50,
    historyDays: 90,
    webhooks: true,
    requestsPerSecond: 50,
  },
  // Not sold: for the operator's own servers (accounts migrated from the single-server bot).
  internal: {
    id: 'internal',
    name: 'Internal',
    priceUsd: 0,
    hidden: true,
    apps: Infinity,
    accountKeys: 25,
    aiChecksPerMonth: Infinity,
    customRules: 50,
    historyDays: 90,
    webhooks: true,
    requestsPerSecond: 100,
  },
};

/** The plan an account is on; unknown plans (and lapsed subscriptions) count as free. */
export function planFor(account) {
  return PLANS[account?.plan] ?? PLANS.free;
}

/** The plan a Stripe price belongs to, or null. */
export function planForPrice(priceId) {
  return Object.values(PLANS).find((p) => p.stripePriceId && p.stripePriceId === priceId) ?? null;
}

/** Plans as shown publicly (no Stripe IDs). */
export function publicPlans() {
  return Object.values(PLANS).filter((p) => !p.hidden)
    .map(({ stripePriceId, ...p }) => ({ ...p, purchasable: p.priceUsd === 0 || Boolean(stripePriceId) }));
}

/** A plan's limits as JSON can carry them (Infinity → null, meaning unlimited). */
export function planLimits(plan) {
  const { stripePriceId, hidden, ...rest } = plan;
  return Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, v === Infinity ? null : v]));
}

// After a downgrade, whatever is past the new plan's limits stops working (oldest first is
// kept) until the plan is upgraded again or the extras are deleted.

/** True when `app` is within its account's plan (its first `plan.apps` apps). */
export function appInPlan(db, app, account = db.accounts.get(app.accountId)) {
  return db.apps.rank(app) < planFor(account).apps;
}

/** The custom rules that apply: the app's oldest `plan.customRules`. */
export function rulesInPlan(db, app, account = db.accounts.get(app.accountId)) {
  return db.rules.list(app.id).slice(0, planFor(account).customRules);
}
