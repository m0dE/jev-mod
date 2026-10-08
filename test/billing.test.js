// Billing: Checkout, the portal and the Stripe webhook, against a fake Stripe (no network).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// plans.js reads price IDs at import time, so set them before importing anything.
process.env.STRIPE_PRICE_STARTER = 'price_starter_test';
process.env.STRIPE_PRICE_PRO = 'price_pro_test';
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;

const { openDb } = await import('../src/db.js');
const { createServer } = await import('../src/server/index.js');
const { createBilling } = await import('../src/server/billing.js');
const { config } = await import('../src/config.js');

const SIG = 'good-signature';
const quiet = { log() {}, warn() {}, error() {} };

/** A fake Stripe that records calls. `subs` holds the subscriptions Stripe "has". */
function fakeStripe() {
  const calls = [];
  const subs = new Map();
  const sessions = new Map();
  let n = 0;
  const fake = {
    calls,
    subs,
    sessions,
    // Set to a promise to hold subscriptions.retrieve until it resolves (a slow handler).
    hold: null,
    customers: {
      create: async (params) => { calls.push(['customers.create', params]); return { id: `cus_${++n}` }; },
    },
    subscriptions: {
      list: async (params) => { calls.push(['subscriptions.list', params]); return { data: [...subs.values()].filter((s) => s.customer === params.customer) }; },
      retrieve: async (id) => {
        calls.push(['subscriptions.retrieve', id]);
        if (!subs.has(id)) throw Object.assign(new Error(`No such subscription: ${id}`), { type: 'StripeInvalidRequestError' });
        const snapshot = structuredClone(subs.get(id));
        if (fake.hold) await fake.hold;
        return snapshot;
      },
      cancel: async (id, params) => {
        calls.push(['subscriptions.cancel', id, params]);
        subs.set(id, { ...subs.get(id), status: 'canceled' });
        return subs.get(id);
      },
    },
    checkout: {
      sessions: {
        create: async (params) => {
          calls.push(['checkout.create', params]);
          const id = `cs_${++n}`;
          sessions.set(id, { id, customer: params.customer, status: 'open' });
          return { id, url: `https://checkout.stripe.test/${id}` };
        },
        list: async (params) => {
          calls.push(['checkout.list', params]);
          return { data: [...sessions.values()].filter((x) => x.customer === params.customer && x.status === params.status) };
        },
        expire: async (id) => { calls.push(['checkout.expire', id]); sessions.get(id).status = 'expired'; return sessions.get(id); },
      },
    },
    billingPortal: {
      sessions: { create: async (params) => { calls.push(['portal.create', params]); return { url: 'https://billing.stripe.test/p_1' }; } },
    },
    webhooks: {
      // The signature is "good-signature" or it's rejected.
      constructEvent: (raw, sig) => {
        if (sig !== SIG) throw new Error('No signatures found matching the expected signature for payload');
        return JSON.parse(raw.toString('utf8'));
      },
    },
  };
  return fake;
}

const sub = (id, customer, status, price = 'price_starter_test', periodEnd = 1_900_000_000, created = 1_800_000_000) => ({
  id, object: 'subscription', customer, status, metadata: {}, created,
  items: { data: [{ id: `si_${id}`, price: { id: price }, current_period_end: periodEnd }] },
});

async function startServer(billing, db) {
  const app = createServer({
    db,
    moderator: { moderate: async () => ({}), standing: () => ({}), warn: () => ({}), pardon: () => ({}) },
    routers: [{ path: '/webhooks/stripe', router: billing.webhookRouter }],
    apiExtensions: [billing.extendApi],
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base };
}

let db, stripe, base, server, offBase, offServer, account, acctKey, appKey;
let eventN = 0;

before(async () => {
  db = openDb(':memory:');
  stripe = fakeStripe();
  ({ server, base } = await startServer(createBilling({ db, stripe, webhookSecret: 'whsec_test', log: quiet }), db));
  // Billing on a server without Stripe.
  ({ server: offServer, base: offBase } = await startServer(createBilling({ db, stripe: null, webhookSecret: null, log: quiet }), db));

  account = db.accounts.create({ email: 'owner@example.com', name: 'Owner' });
  acctKey = db.keys.create({ accountId: account.id, kind: 'account', name: 'agent' }).secret;
  const app = db.apps.create({ accountId: account.id, name: 'Game', kind: 'api' });
  appKey = db.keys.create({ accountId: account.id, appId: app.id, kind: 'app', name: 'game' }).secret;
});

after(() => {
  server.close();
  offServer.close();
  db.close();
});

const call = (url, method, key, body) => fetch(url, {
  method,
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, body: await r.json() }));

const sendEvent = (type, object, { id = `evt_${++eventN}`, sig = SIG, url = base } = {}) => fetch(`${url}/webhooks/stripe`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sig },
  body: JSON.stringify({ id, type, data: { object } }),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

const newAccount = (email, plan = 'free') => {
  const a = db.accounts.create({ email, plan });
  return { account: a, key: db.keys.create({ accountId: a.id, kind: 'account', name: 'k' }).secret };
};

test('checkout creates a Stripe customer and returns the Checkout URL', async () => {
  const r = await call(`${base}/v1/billing/checkout`, 'POST', acctKey, { plan: 'pro' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.url, /^https:\/\/checkout\.stripe\.test\/cs_/);
  assert.equal(r.body.kind, 'checkout');

  const [, cust] = stripe.calls.find(([c]) => c === 'customers.create');
  assert.deepEqual(cust, { email: 'owner@example.com', name: 'Owner', metadata: { accountId: account.id } });
  const customerId = db.accounts.get(account.id).stripeCustomerId;
  assert.equal(customerId, 'cus_1');

  const [, s] = stripe.calls.find(([c]) => c === 'checkout.create');
  assert.equal(s.mode, 'subscription');
  assert.equal(s.customer, customerId);
  assert.deepEqual(s.line_items, [{ price: 'price_pro_test', quantity: 1 }]);
  assert.equal(s.client_reference_id, account.id);
  assert.equal(s.metadata.accountId, account.id);
  assert.equal(s.subscription_data.metadata.accountId, account.id);
  assert.equal(s.allow_promotion_codes, true);
  assert.equal(s.success_url, `${config.publicUrl}/app/account?checkout=success`);
  assert.equal(s.cancel_url, `${config.publicUrl}/app/account?checkout=canceled`);

  // A second checkout reuses the customer.
  stripe.calls.length = 0;
  await call(`${base}/v1/billing/checkout`, 'POST', acctKey, { plan: 'starter' });
  assert.equal(stripe.calls.filter(([c]) => c === 'customers.create').length, 0);
});

test('checkout refuses app keys, bad plans and internal accounts', async () => {
  let r = await call(`${base}/v1/billing/checkout`, 'POST', appKey, { plan: 'pro' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'forbidden');
  r = await call(`${base}/v1/billing/portal`, 'POST', appKey);
  assert.equal(r.status, 403);

  for (const plan of ['free', 'internal', 'gold', undefined]) {
    r = await call(`${base}/v1/billing/checkout`, 'POST', acctKey, { plan });
    assert.equal(r.status, 400, `plan ${plan}`);
  }

  const { key } = newAccount('internal@example.com', 'internal');
  r = await call(`${base}/v1/billing/checkout`, 'POST', key, { plan: 'pro' });
  assert.equal(r.status, 400);
});

test('without Stripe configured, billing answers 503', async () => {
  let r = await call(`${offBase}/v1/billing/checkout`, 'POST', acctKey, { plan: 'starter' });
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, 'billing_unavailable');
  r = await call(`${offBase}/v1/billing/portal`, 'POST', acctKey);
  assert.equal(r.status, 503);
  r = await call(`${offBase}/v1/billing`, 'GET', acctKey);
  assert.equal(r.body.enabled, false);
  r = await sendEvent('customer.subscription.updated', {}, { url: offBase });
  assert.equal(r.status, 503);
});

test('portal needs a Stripe customer', async () => {
  const { key } = newAccount('nocust@example.com');
  let r = await call(`${base}/v1/billing/portal`, 'POST', key);
  assert.equal(r.status, 400);
  r = await call(`${base}/v1/billing/portal`, 'POST', acctKey);
  assert.equal(r.status, 200);
  assert.equal(r.body.url, 'https://billing.stripe.test/p_1');
  const [, p] = stripe.calls.findLast(([c]) => c === 'portal.create');
  assert.deepEqual(p, { customer: 'cus_1', return_url: `${config.publicUrl}/app/account` });
});

test('webhook rejects a bad signature', async () => {
  const r = await sendEvent('customer.subscription.updated', sub('sub_x', 'cus_1', 'active'), { sig: 'forged' });
  assert.equal(r.status, 400);
  assert.equal(db.accounts.get(account.id).plan, 'free');
});

test('subscription events set the plan; deleted goes back to free', async () => {
  const { account: a } = newAccount('sync@example.com');
  db.accounts.setBilling(a.id, { stripeCustomerId: 'cus_sync' });

  stripe.subs.set('sub_s', sub('sub_s', 'cus_sync', 'active', 'price_starter_test', 1_900_000_000));
  let r = await sendEvent('customer.subscription.created', stripe.subs.get('sub_s'));
  assert.deepEqual(r, { status: 200, body: { received: true } });
  let acc = db.accounts.get(a.id);
  assert.equal(acc.plan, 'starter');
  assert.equal(acc.stripeSubscriptionId, 'sub_s');
  assert.equal(acc.subscriptionStatus, 'active');
  assert.equal(acc.currentPeriodEnd, 1_900_000_000_000);

  // Upgrade in the portal.
  stripe.subs.set('sub_s', sub('sub_s', 'cus_sync', 'active', 'price_pro_test', 1_900_100_000));
  await sendEvent('customer.subscription.updated', stripe.subs.get('sub_s'));
  assert.equal(db.accounts.get(a.id).plan, 'pro');

  // A checkout now sends them to the portal instead.
  const { key } = { key: db.keys.create({ accountId: a.id, kind: 'account', name: 'k2' }).secret };
  const c = await call(`${base}/v1/billing/checkout`, 'POST', key, { plan: 'starter' });
  assert.equal(c.body.kind, 'portal');
  assert.equal(c.body.url, 'https://billing.stripe.test/p_1');

  // GET /v1/billing reports it.
  const b = await call(`${base}/v1/billing`, 'GET', key);
  assert.deepEqual(b.body, { enabled: true, plan: 'pro', subscriptionStatus: 'active', currentPeriodEnd: new Date(1_900_100_000_000).toISOString(), hasCustomer: true });

  const ended = { ...sub('sub_s', 'cus_sync', 'canceled', 'price_pro_test') };
  stripe.subs.set('sub_s', ended);
  await sendEvent('customer.subscription.deleted', ended);
  acc = db.accounts.get(a.id);
  assert.equal(acc.plan, 'free');
  assert.equal(acc.subscriptionStatus, 'canceled');
});

test('past_due keeps the paid plan; unpaid drops to free', async () => {
  const { account: a } = newAccount('late@example.com');
  db.accounts.setBilling(a.id, { stripeCustomerId: 'cus_late' });
  stripe.subs.set('sub_l', sub('sub_l', 'cus_late', 'active', 'price_pro_test'));
  await sendEvent('customer.subscription.updated', stripe.subs.get('sub_l'));
  assert.equal(db.accounts.get(a.id).plan, 'pro');

  stripe.subs.set('sub_l', sub('sub_l', 'cus_late', 'past_due', 'price_pro_test'));
  await sendEvent('customer.subscription.updated', stripe.subs.get('sub_l'));
  let acc = db.accounts.get(a.id);
  assert.equal(acc.plan, 'pro');
  assert.equal(acc.subscriptionStatus, 'past_due');

  stripe.subs.set('sub_l', sub('sub_l', 'cus_late', 'unpaid', 'price_pro_test'));
  await sendEvent('customer.subscription.updated', stripe.subs.get('sub_l'));
  acc = db.accounts.get(a.id);
  assert.equal(acc.plan, 'free');
  assert.equal(acc.subscriptionStatus, 'unpaid');
});

test('internal accounts are never changed', async () => {
  const { account: a } = newAccount('ops@example.com', 'internal');
  db.accounts.setBilling(a.id, { stripeCustomerId: 'cus_ops' });
  stripe.subs.set('sub_o', sub('sub_o', 'cus_ops', 'active', 'price_starter_test'));
  await sendEvent('customer.subscription.updated', stripe.subs.get('sub_o'));
  await sendEvent('customer.subscription.deleted', { ...stripe.subs.get('sub_o'), status: 'canceled' });
  const acc = db.accounts.get(a.id);
  assert.equal(acc.plan, 'internal');
  assert.equal(acc.stripeSubscriptionId, null);
});

test('a duplicate event is processed once', async () => {
  const { account: a } = newAccount('dup@example.com');
  db.accounts.setBilling(a.id, { stripeCustomerId: 'cus_dup' });
  stripe.subs.set('sub_d', sub('sub_d', 'cus_dup', 'active', 'price_starter_test'));
  const first = await sendEvent('customer.subscription.created', stripe.subs.get('sub_d'), { id: 'evt_dup' });
  assert.equal(first.status, 200);
  assert.equal(db.accounts.get(a.id).plan, 'starter');

  // Stripe redelivers it after the account changed by other means; nothing happens.
  db.accounts.setBilling(a.id, { plan: 'free' });
  const before = stripe.calls.length;
  const again = await sendEvent('customer.subscription.created', stripe.subs.get('sub_d'), { id: 'evt_dup' });
  assert.deepEqual(again.body, { received: true, duplicate: true });
  assert.equal(db.accounts.get(a.id).plan, 'free');
  assert.equal(stripe.calls.length, before);
});

test('checkout.session.completed links the customer and syncs the subscription', async () => {
  const { account: a } = newAccount('new@example.com');
  stripe.subs.set('sub_n', sub('sub_n', 'cus_new', 'active', 'price_pro_test'));
  const r = await sendEvent('checkout.session.completed', {
    id: 'cs_n', object: 'checkout.session', mode: 'subscription', customer: 'cus_new', subscription: 'sub_n',
    client_reference_id: a.id, metadata: { accountId: a.id },
  });
  assert.equal(r.status, 200);
  const acc = db.accounts.get(a.id);
  assert.equal(acc.stripeCustomerId, 'cus_new');
  assert.equal(acc.plan, 'pro');
  assert.equal(acc.stripeSubscriptionId, 'sub_n');
});

test('a non-billing second subscription is ignored while the current one is live', async () => {
  const { account: a } = newAccount('two@example.com');
  db.accounts.setBilling(a.id, { stripeCustomerId: 'cus_two' });
  stripe.subs.set('sub_a', sub('sub_a', 'cus_two', 'active', 'price_pro_test'));
  await sendEvent('customer.subscription.created', stripe.subs.get('sub_a'));
  stripe.subs.set('sub_b', sub('sub_b', 'cus_two', 'canceled', 'price_starter_test'));
  await sendEvent('customer.subscription.deleted', stripe.subs.get('sub_b'));
  let acc = db.accounts.get(a.id);
  assert.equal(acc.plan, 'pro');
  assert.equal(acc.stripeSubscriptionId, 'sub_a');

  // Once the current one has ended, a new subscription takes over.
  await sendEvent('customer.subscription.deleted', { ...stripe.subs.get('sub_a'), status: 'canceled' });
  stripe.subs.set('sub_c', sub('sub_c', 'cus_two', 'active', 'price_starter_test'));
  await sendEvent('customer.subscription.created', stripe.subs.get('sub_c'));
  acc = db.accounts.get(a.id);
  assert.equal(acc.plan, 'starter');
  assert.equal(acc.stripeSubscriptionId, 'sub_c');
});

test('a failure while handling an event answers 500 so Stripe retries', async () => {
  const r = await sendEvent('customer.subscription.updated', sub('sub_missing', 'cus_1', 'active'), { id: 'evt_fail' });
  assert.equal(r.status, 500);
  assert.equal(db.meta.get('stripe_event:evt_fail'), null);
});

test('starting a checkout expires the customer\'s other open checkouts', async () => {
  const { account: a, key } = newAccount('tabs@example.com');
  const first = await call(`${base}/v1/billing/checkout`, 'POST', key, { plan: 'starter' });
  const firstId = first.body.url.split('/').pop();
  assert.equal(stripe.sessions.get(firstId).status, 'open');
  const second = await call(`${base}/v1/billing/checkout`, 'POST', key, { plan: 'pro' });
  const secondId = second.body.url.split('/').pop();
  assert.equal(stripe.sessions.get(firstId).status, 'expired');
  assert.equal(stripe.sessions.get(secondId).status, 'open');
  assert.equal(db.accounts.get(a.id).stripeCustomerId, stripe.sessions.get(secondId).customer);
});

test('a second billing subscription replaces the first, which is canceled', async () => {
  const { account: a } = newAccount('double@example.com');
  db.accounts.setBilling(a.id, { stripeCustomerId: 'cus_dbl' });
  stripe.subs.set('sub_old', sub('sub_old', 'cus_dbl', 'active', 'price_starter_test', 1_900_000_000, 1_800_000_000));
  await sendEvent('customer.subscription.created', stripe.subs.get('sub_old'));
  assert.equal(db.accounts.get(a.id).plan, 'starter');

  // Paid for Pro in another tab: the newer subscription wins and the old one is canceled.
  stripe.subs.set('sub_new', sub('sub_new', 'cus_dbl', 'active', 'price_pro_test', 1_900_000_000, 1_800_000_100));
  const r = await sendEvent('customer.subscription.created', stripe.subs.get('sub_new'));
  assert.equal(r.status, 200);
  let acc = db.accounts.get(a.id);
  assert.equal(acc.plan, 'pro');
  assert.equal(acc.stripeSubscriptionId, 'sub_new');
  const cancel = stripe.calls.find(([c, id]) => c === 'subscriptions.cancel' && id === 'sub_old');
  assert.ok(cancel, 'old subscription canceled');
  assert.equal(cancel[2].prorate, true);
  assert.equal(stripe.subs.get('sub_old').status, 'canceled');

  // The old one's deleted event changes nothing.
  await sendEvent('customer.subscription.deleted', stripe.subs.get('sub_old'));
  acc = db.accounts.get(a.id);
  assert.equal(acc.plan, 'pro');
  assert.equal(acc.stripeSubscriptionId, 'sub_new');

  // A late event for an older subscription that's still billing: that one is canceled instead.
  stripe.subs.set('sub_older', sub('sub_older', 'cus_dbl', 'active', 'price_starter_test', 1_900_000_000, 1_700_000_000));
  await sendEvent('customer.subscription.created', stripe.subs.get('sub_older'));
  acc = db.accounts.get(a.id);
  assert.equal(acc.plan, 'pro');
  assert.equal(acc.stripeSubscriptionId, 'sub_new');
  assert.equal(stripe.subs.get('sub_older').status, 'canceled');
  assert.equal(stripe.subs.get('sub_new').status, 'active');
});

test('a slow update cannot undo a cancellation', async () => {
  const { account: a } = newAccount('race@example.com');
  db.accounts.setBilling(a.id, { stripeCustomerId: 'cus_race' });
  stripe.subs.set('sub_r', sub('sub_r', 'cus_race', 'active', 'price_pro_test'));
  await sendEvent('customer.subscription.created', stripe.subs.get('sub_r'));
  assert.equal(db.accounts.get(a.id).plan, 'pro');

  // The update handler fetches the subscription while it's still active, then stalls...
  let release;
  stripe.hold = new Promise((resolve) => { release = resolve; });
  const slow = sendEvent('customer.subscription.updated', stripe.subs.get('sub_r'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  // ...meanwhile the subscription is canceled and the deleted event is handled.
  stripe.hold = null;
  stripe.subs.set('sub_r', { ...stripe.subs.get('sub_r'), status: 'canceled' });
  await sendEvent('customer.subscription.deleted', stripe.subs.get('sub_r'));
  assert.equal(db.accounts.get(a.id).plan, 'free');

  release();
  assert.equal((await slow).status, 200);
  let acc = db.accounts.get(a.id);
  assert.equal(acc.plan, 'free');
  assert.equal(acc.subscriptionStatus, 'canceled');

  // Even an "active" snapshot of that subscription arriving later is ignored.
  stripe.subs.set('sub_r', { ...stripe.subs.get('sub_r'), status: 'active' });
  await sendEvent('customer.subscription.updated', stripe.subs.get('sub_r'));
  acc = db.accounts.get(a.id);
  assert.equal(acc.plan, 'free');
});
