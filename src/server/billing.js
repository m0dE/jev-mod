// Stripe billing: Checkout to subscribe, the Customer Portal to change plan or cancel, and the
// webhook at /webhooks/stripe that keeps each account's plan in sync with its subscription.
//
// Plan changes go through the Customer Portal: /v1/billing/checkout only starts *new*
// subscriptions. If the customer already has a live subscription it returns a portal URL
// instead (`kind: "portal"`), and starting a Checkout expires any other open one for the
// customer. If two subscriptions still end up billing, the webhook cancels the older one.
//
// Accounts on the hidden `internal` plan are never changed by anything here.

import express from 'express';
import Stripe from 'stripe';
import { config } from '../config.js';
import { PLANS, planFor, planForPrice } from '../plans.js';

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const idOf = (v) => (v == null ? null : typeof v === 'string' ? v : v.id);

// Subscription statuses where the customer is (or may again be) paying. A new Checkout is
// refused while one of these exists.
const LIVE = new Set(['active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete']);
// Statuses that mean "no paid plan" (paused: a trial ended without a payment method).
const ENDED = new Set(['canceled', 'unpaid', 'incomplete_expired', 'paused']);
// Statuses a subscription never leaves.
const TERMINAL = new Set(['canceled', 'incomplete_expired']);
// Statuses where Stripe is charging (or retrying a charge) for the subscription.
const BILLING = new Set(['active', 'trialing', 'past_due']);
const PAID_PLANS = new Set(['starter', 'pro']);
// Processed webhook event IDs are remembered this long (Stripe retries for up to 3 days).
const KEEP_EVENTS_MS = 30 * 24 * 60 * 60_000;

/** The subscription item that carries one of our plans' prices (or the first item). */
function planItem(sub) {
  const items = sub.items?.data ?? [];
  return items.find((i) => planForPrice(idOf(i.price))) ?? items[0] ?? null;
}

export function createBilling({
  db,
  stripe = config.stripeSecretKey ? new Stripe(config.stripeSecretKey) : null,
  webhookSecret = config.stripeWebhookSecret,
  log = console,
}) {
  const enabled = () => Boolean(stripe) && Object.values(PLANS).some((p) => p.stripePriceId);

  // --- Plan sync ---

  // Canceled is final in Stripe, so once we've seen a subscription canceled we remember it and
  // never let a slower, older-looking update for it put the account back on a paid plan.
  const canceledKey = (subId) => `stripe_sub_canceled:${subId}`;
  const markCanceled = (subId) => db.meta.set(canceledKey(subId), String(db.now()));
  const isCanceled = (sub) => sub.status === 'canceled' || Boolean(db.meta.get(canceledKey(sub.id)));
  const statusOf = (sub) => (isCanceled(sub) ? 'canceled' : sub.status);

  /** Cancel a duplicate subscription, crediting its unused time to the customer's balance. */
  async function cancelDuplicate(sub, account, reason) {
    log.warn(`[billing] account ${account.id}: canceling subscription ${sub.id} (${sub.status}) — ${reason}`);
    await stripe.subscriptions.cancel(sub.id, {
      prorate: true,
      invoice_now: true,
      cancellation_details: { comment: `Jef Bot: duplicate subscription (${reason})` },
    });
    markCanceled(sub.id);
  }

  /** The account a subscription belongs to: by customer, else by metadata / Checkout hint. */
  function accountForSub(sub, accountIdHint) {
    const customerId = idOf(sub.customer);
    const byCustomer = customerId ? db.accounts.byStripeCustomer(customerId) : null;
    if (byCustomer) return byCustomer;
    const fallbackId = sub.metadata?.accountId || accountIdHint;
    const byMeta = fallbackId ? db.accounts.get(fallbackId) : null;
    if (!byMeta) return null;
    if (byMeta.stripeCustomerId && byMeta.stripeCustomerId !== customerId) {
      log.warn(`[billing] subscription ${sub.id}: account ${byMeta.id} belongs to customer ${byMeta.stripeCustomerId}, not ${customerId}; ignored`);
      return null;
    }
    return customerId ? db.accounts.setBilling(byMeta.id, { stripeCustomerId: customerId }) : byMeta;
  }

  /**
   * Bring an account in line with a Stripe subscription. `deleted` is true for
   * customer.subscription.deleted. `accountIdHint` comes from a Checkout session.
   */
  async function syncSubscription(sub, { deleted = false, accountIdHint = null } = {}) {
    if (deleted || sub.status === 'canceled') markCanceled(sub.id);
    let account = accountForSub(sub, accountIdHint);
    if (!account) {
      log.warn(`[billing] subscription ${sub.id} (customer ${idOf(sub.customer)}) matches no account; ignored`);
      return;
    }
    if (account.plan === 'internal') {
      log.log(`[billing] account ${account.id} is on the internal plan; subscription ${sub.id} not applied`);
      return;
    }

    // A customer with more than one subscription: only one may stay billing. The account follows
    // its current subscription; a newer billing one replaces it and the older one is canceled.
    const currentId = account.stripeSubscriptionId;
    if (currentId && currentId !== sub.id && !TERMINAL.has(account.subscriptionStatus) && !db.meta.get(canceledKey(currentId))) {
      if (!BILLING.has(statusOf(sub))) {
        log.warn(`[billing] account ${account.id}: ignoring subscription ${sub.id} (${statusOf(sub)}); current is ${currentId} (${account.subscriptionStatus})`);
        return;
      }
      const current = await stripe.subscriptions.retrieve(currentId);
      if (!TERMINAL.has(statusOf(current))) {
        const keepNew = !BILLING.has(statusOf(current)) || (sub.created ?? 0) >= (current.created ?? 0);
        const [keep, drop] = keepNew ? [sub, current] : [current, sub];
        await cancelDuplicate(drop, account, `customer has two subscriptions; keeping ${keep.id}`);
        if (!keepNew) return;
      }
      log.log(`[billing] account ${account.id}: subscription ${sub.id} replaces ${currentId}`);
      // Re-read after the awaits above; another event may have changed things meanwhile.
      account = db.accounts.get(account.id);
      if (account.plan === 'internal') return;
    }

    // Nothing is awaited from here on, so this check and the write below can't interleave
    // with another event's handler.
    const status = deleted ? 'canceled' : statusOf(sub);
    const item = planItem(sub);
    const pricePlan = item ? planForPrice(idOf(item.price)) : null;
    let plan;
    if (ENDED.has(status)) {
      plan = 'free';
    } else if (status === 'active' || status === 'trialing') {
      plan = pricePlan?.id ?? account.plan;
      if (!pricePlan) log.error(`[billing] account ${account.id}: subscription ${sub.id} has no known price (${idOf(item?.price)}); plan left as ${account.plan}`);
    } else if (status === 'past_due') {
      // Grace while Stripe retries the payment: keep the paid plan they had.
      plan = PAID_PLANS.has(account.plan) ? account.plan : (pricePlan?.id ?? account.plan);
    } else {
      // incomplete: the first payment hasn't gone through yet.
      plan = account.plan;
    }

    const updated = db.accounts.setBilling(account.id, {
      plan,
      stripeSubscriptionId: sub.id,
      subscriptionStatus: status,
      currentPeriodEnd: item?.current_period_end ? item.current_period_end * 1000 : null,
    });
    if (updated.plan !== account.plan) log.log(`[billing] account ${account.id}: ${account.plan} → ${updated.plan} (subscription ${sub.id} ${status})`);
  }

  async function onCheckoutCompleted(session) {
    if (session.mode !== 'subscription') return;
    const accountId = session.client_reference_id || session.metadata?.accountId || null;
    const customerId = idOf(session.customer);
    const account = accountId ? db.accounts.get(accountId) : null;
    if (account && customerId && !account.stripeCustomerId) {
      const other = db.accounts.byStripeCustomer(customerId);
      if (other) log.warn(`[billing] checkout ${session.id}: customer ${customerId} already belongs to account ${other.id}`);
      else db.accounts.setBilling(account.id, { stripeCustomerId: customerId });
    }
    const subId = idOf(session.subscription);
    if (!subId) return;
    await syncSubscription(await stripe.subscriptions.retrieve(subId), { accountIdHint: accountId });
  }

  async function handleEvent(event) {
    const obj = event.data?.object ?? {};
    switch (event.type) {
      case 'checkout.session.completed':
        return onCheckoutCompleted(obj);
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        // Events can arrive out of order, so act on the subscription as it is now.
        return syncSubscription(await stripe.subscriptions.retrieve(obj.id));
      case 'customer.subscription.deleted':
        return syncSubscription(obj, { deleted: true });
      case 'invoice.payment_failed': {
        const account = db.accounts.byStripeCustomer(idOf(obj.customer));
        const subId = idOf(obj.parent?.subscription_details?.subscription);
        log.warn(`[billing] payment failed: invoice ${obj.id}, customer ${idOf(obj.customer)}, account ${account?.id ?? 'unknown'}, subscription ${subId ?? '-'}, attempt ${obj.attempt_count ?? '?'}`);
        return;
      }
      default:
        return;
    }
  }

  let lastPrune = 0;
  function pruneEvents() {
    const t = db.now();
    if (t - lastPrune < 60 * 60_000) return;
    lastPrune = t;
    db.raw.prepare("DELETE FROM meta WHERE key LIKE 'stripe_event:%' AND CAST(value AS INTEGER) < ?").run(t - KEEP_EVENTS_MS);
  }

  // --- Webhook ---

  const webhookRouter = express.Router();
  webhookRouter.post('/', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
    if (!stripe || !webhookSecret) return res.status(503).json({ error: { code: 'billing_unavailable', message: 'Stripe is not configured' } });
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], webhookSecret);
    } catch (err) {
      return res.status(400).json({ error: { code: 'bad_signature', message: `Webhook signature check failed: ${err.message}` } });
    }
    const seenKey = `stripe_event:${event.id}`;
    if (db.meta.get(seenKey)) return res.json({ received: true, duplicate: true });
    try {
      await handleEvent(event);
      // Recorded only once handled, so a failure is retried by Stripe.
      db.meta.set(seenKey, String(db.now()));
      pruneEvents();
      res.json({ received: true });
    } catch (err) {
      log.error(`[billing] webhook ${event.type} ${event.id} failed:`, err);
      res.status(500).json({ error: { code: 'internal', message: 'Could not process the event' } });
    }
  });

  // --- /v1/billing ---

  function extendApi(router, { route, accountScope, fail, ApiError }) {
    const needStripe = () => {
      if (!stripe) fail(503, 'billing_unavailable', 'Billing is not set up on this server');
    };
    // Stripe errors become 502s with Stripe's message instead of a bare 500.
    const viaStripe = async (fn) => {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof ApiError || !String(err?.type ?? '').startsWith('Stripe')) throw err;
        log.error('[billing] Stripe error:', err.message);
        throw new ApiError(502, 'billing_error', `Stripe: ${err.message}`);
      }
    };

    async function customerFor(account) {
      if (account.stripeCustomerId) return account.stripeCustomerId;
      const customer = await stripe.customers.create({
        email: account.email,
        name: account.name ?? undefined,
        metadata: { accountId: account.id },
      });
      // Another request may have linked one meanwhile; keep the first.
      const now = db.accounts.get(account.id);
      if (now.stripeCustomerId) return now.stripeCustomerId;
      db.accounts.setBilling(account.id, { stripeCustomerId: customer.id });
      return customer.id;
    }

    const portalUrl = async (customer) => (await stripe.billingPortal.sessions.create({
      customer, return_url: `${config.publicUrl}/app/account`,
    })).url;

    router.get('/billing', route((req) => {
      const { account } = accountScope(req);
      return {
        enabled: enabled(),
        plan: planFor(account).id,
        subscriptionStatus: account.subscriptionStatus,
        currentPeriodEnd: iso(account.currentPeriodEnd),
        hasCustomer: Boolean(account.stripeCustomerId),
      };
    }));

    router.post('/billing/checkout', route((req) => viaStripe(async () => {
      const { account } = accountScope(req);
      const planId = req.body?.plan;
      const plan = typeof planId === 'string' && Object.hasOwn(PLANS, planId) ? PLANS[planId] : null;
      if (!plan || plan.hidden || !PAID_PLANS.has(plan.id)) fail(400, 'invalid_request', 'plan must be "starter" or "pro"');
      if (account.plan === 'internal') fail(400, 'invalid_request', 'This account is on the internal plan and does not need a subscription');
      needStripe();
      if (!plan.stripePriceId) fail(503, 'billing_unavailable', `The ${plan.name} plan can't be bought on this server yet`);

      const customer = await customerFor(account);
      // Only one Checkout may be open per customer: paying in two tabs would start two subscriptions.
      const open = await stripe.checkout.sessions.list({ customer, status: 'open', limit: 100 });
      for (const s of open.data) {
        try {
          await stripe.checkout.sessions.expire(s.id);
        } catch (err) {
          // Most likely completed just now; the subscription check below (or the webhook) handles it.
          log.warn(`[billing] could not expire checkout ${s.id}: ${err.message}`);
        }
      }
      // Already subscribed: changing plan happens in the portal (with proration there).
      const subs = await stripe.subscriptions.list({ customer, status: 'all', limit: 20 });
      if (subs.data.some((s) => LIVE.has(s.status))) return { url: await portalUrl(customer), kind: 'portal' };

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer,
        line_items: [{ price: plan.stripePriceId, quantity: 1 }],
        client_reference_id: account.id,
        metadata: { accountId: account.id, plan: plan.id },
        subscription_data: { metadata: { accountId: account.id } },
        allow_promotion_codes: true,
        success_url: `${config.publicUrl}/app/account?checkout=success`,
        cancel_url: `${config.publicUrl}/app/account?checkout=canceled`,
      });
      return { url: session.url, kind: 'checkout' };
    })));

    router.post('/billing/portal', route((req) => viaStripe(async () => {
      const { account } = accountScope(req);
      needStripe();
      if (!account.stripeCustomerId) fail(400, 'no_customer', 'No billing account yet. Subscribe first with POST /v1/billing/checkout.');
      return { url: await portalUrl(account.stripeCustomerId) };
    })));
  }

  return { webhookRouter, extendApi };
}
