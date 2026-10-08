// The Jef Bot dashboard: a small single-page app. The server sends index.html for every
// /app/... path; this file routes with the History API and renders each page from /v1.

import {
  h, clear, api, ApiFail, notice, messageSlot, busy, field, meter, kindBadge, secretBox, toast,
  confirmDialog, curlExample, discordLinkPanel, discordError, fmtNum, fmtDay, timeEl,
} from './lib.js';
import { appPage } from './app-detail.js';

const main = document.getElementById('main');
const nav = document.getElementById('nav');

// --- Routing ---

const routes = [
  [/^\/app\/?$/, overviewPage, 'Apps'],
  [/^\/app\/login\/?$/, loginPage, 'Sign in'],
  [/^\/app\/new\/?$/, newAppPage, 'New app'],
  [/^\/app\/account\/?$/, accountPage, 'Account'],
  [/^\/app\/apps\/([^/]+)(?:\/([a-z-]+))?\/?$/, appPage, 'App'],
];

export function navigate(url, { replace = false } = {}) {
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  render({ focus: true });
}

/** Drop a one-time query parameter (like ?checkout=success) so a reload doesn't repeat its banner. */
export function dropParam(name) {
  const url = new URL(location.href);
  if (!url.searchParams.has(name)) return;
  url.searchParams.delete(name);
  history.replaceState(null, '', url.pathname + url.search + url.hash);
}

let renderId = 0;
async function render({ focus = false } = {}) {
  const id = ++renderId;
  const path = location.pathname;
  const match = routes.map(([re, page, title]) => [re.exec(path), page, title]).find(([m]) => m);
  const query = new URLSearchParams(location.search);
  renderNav(path);
  clear(main, h('p', { class: 'loading' }, 'Loading…'));
  if (!match) {
    clear(main, h('h1', { tabindex: '-1' }, 'Page not found'), h('p', {}, h('a', { href: '/app' }, 'Back to your apps')));
    return;
  }
  const [m, page, title] = match;
  document.title = `${title} · Jef Bot`;
  const view = h('div', { class: 'page' });
  try {
    await page(view, { params: m.slice(1).map((p) => (p == null ? p : decodeURIComponent(p))), query, setTitle: (t) => { document.title = `${t} · Jef Bot`; } });
  } catch (err) {
    if (err instanceof ApiFail && err.status === 401) return; // on the way to the sign-in page
    clear(view, h('h1', { tabindex: '-1' }, 'Something went wrong'), notice('error', err.message ?? String(err)),
      h('p', {}, h('a', { href: '/app' }, 'Back to your apps')));
  }
  if (id !== renderId) return; // a newer navigation won
  clear(main, view);
  if (focus) (main.querySelector('h1') ?? main).focus({ preventScroll: false });
}

function renderNav(path) {
  if (path.startsWith('/app/login')) {
    clear(nav, h('a', { href: '/docs/' }, 'Docs'));
    return;
  }
  const link = (href, label, active) => h('a', { href, 'aria-current': active ? 'page' : null }, label);
  clear(nav,
    link('/app', 'Apps', path === '/app' || path === '/app/' || path.startsWith('/app/apps') || path.startsWith('/app/new')),
    link('/app/account', 'Account', path.startsWith('/app/account')),
    h('a', { href: '/docs/' }, 'Docs'),
    h('button', { type: 'button', class: 'nav-button', onclick: signOut }, 'Sign out'));
}

async function signOut() {
  try {
    await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } });
  } finally {
    location.assign('/app/login');
  }
}

// Same-site links to /app/... stay in the page.
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href]');
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  if (a.target || a.hasAttribute('download')) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || !/^\/app(\/|$)/.test(url.pathname)) return;
  e.preventDefault();
  if (url.pathname + url.search === location.pathname + location.search && url.hash) return void (location.hash = url.hash);
  navigate(url.pathname + url.search + url.hash);
});
window.addEventListener('popstate', () => render({ focus: true }));
render();

// --- Sign in ---

const LOGIN_ERRORS = {
  state: 'Your sign-in expired or was started in another tab. Please try again.',
  denied: 'Sign-in was canceled.',
  exchange: "Google sign-in didn't work. Please try again.",
  failed: 'Something went wrong while signing you in. Please try again.',
  unverified: "Your Google account's email address isn't verified yet. Verify it with Google, then try again.",
  email_conflict: 'That email address is already used by a different Google account.',
  google_unavailable: "Google sign-in isn't set up on this server yet.",
  bad_email: 'Enter a valid email address.',
};

async function loginPage(view, { query }) {
  const next = query.get('next')?.startsWith('/app') ? query.get('next') : '/app';
  // Already signed in? Go straight on.
  const me = await api('GET', '/account', undefined, { allow401: true }).catch(() => null);
  if (me?.account) return navigate(next, { replace: true });
  const cfg = await fetch('/auth/config', { credentials: 'same-origin' }).then((r) => r.json()).catch(() => ({ google: false, dev: false }));
  const error = query.get('error');

  const devEmail = h('input', { type: 'email', id: 'dev-email', name: 'email', required: true, autocomplete: 'email', placeholder: 'you@example.com' });
  clear(view, h('div', { class: 'login' },
    h('div', { class: 'card login-card' },
      h('div', { class: 'login-mark', 'aria-hidden': 'true' }, 'J'),
      h('h1', { tabindex: '-1' }, 'Sign in to Jef Bot'),
      h('p', { class: 'muted' }, 'AI chat moderation for your Discord servers and games.'),
      error && notice('error', LOGIN_ERRORS[error] ?? 'Sign-in failed. Please try again.'),
      cfg.google
        ? h('a', { class: 'btn btn-google btn-large', href: `/auth/google?next=${encodeURIComponent(next)}` },
          h('span', { class: 'g-icon', 'aria-hidden': 'true' }), 'Sign in with Google')
        : notice('info', "Google sign-in isn't configured on this server yet."),
      cfg.dev && h('form', { class: 'dev-login', method: 'get', action: '/auth/dev' },
        h('p', { class: 'dev-label' }, 'Developer sign-in (local testing only)'),
        field('Email', devEmail),
        h('input', { type: 'hidden', name: 'next', value: next }),
        h('button', { type: 'submit', class: 'btn btn-ghost' }, 'Sign in with email')),
      h('p', { class: 'fine' }, 'By signing in you agree to the ', h('a', { href: '/terms' }, 'terms'), ' and ', h('a', { href: '/privacy' }, 'privacy policy'), '.'))));
  drawGoogleG(view.querySelector('.g-icon'));
}

// The Google "G", drawn with DOM calls (no innerHTML).
function drawGoogleG(slot) {
  if (!slot) return;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 18 18', width: '18', height: '18', focusable: 'false' })) svg.setAttribute(k, v);
  slot.append(svg);
  const paths = [
    ['#4285F4', 'M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z'],
    ['#34A853', 'M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.33-1.58-5.04-3.7H.96v2.33A9 9 0 0 0 9 18z'],
    ['#FBBC05', 'M3.96 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.28-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3-2.33z'],
    ['#EA4335', 'M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3 2.33C4.67 5.16 6.66 3.58 9 3.58z'],
  ];
  for (const [fill, d] of paths) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('fill', fill);
    p.setAttribute('d', d);
    svg.append(p);
  }
}

// --- Overview ---

async function overviewPage(view, { query }) {
  const discordReason = query.get('discord') === 'error' ? discordError(query.get('reason')) : null;
  dropParam('discord');
  dropParam('reason');
  const [me, { apps }] = await Promise.all([api('GET', '/account'), api('GET', '/apps')]);
  const { limits, usage, account } = me;
  const atLimit = limits.apps != null && usage.apps >= limits.apps;

  const appList = apps.length
    ? h('ul', { class: 'app-list' }, apps.map((app) => h('li', {},
      h('a', { class: 'app-row', href: `/app/apps/${encodeURIComponent(app.id)}` },
        h('span', { class: 'app-row-main' },
          h('span', { class: 'app-name' }, app.name),
          h('span', { class: 'app-meta' },
            app.kind === 'discord'
              ? (app.discordGuildId ? h('span', { class: 'status status-ok' }, 'Linked') : h('span', { class: 'status status-warn' }, 'Not linked yet'))
              : h('span', {}, 'Game / chat API'),
            h('span', { 'aria-hidden': 'true' }, ' · '),
            `${app.rules?.length ?? 0} custom rule${app.rules?.length === 1 ? '' : 's'}`,
            h('span', { 'aria-hidden': 'true' }, ' · '),
            'Created ', fmtDay(app.createdAt))),
        kindBadge(app.kind),
        h('span', { class: 'chev', 'aria-hidden': 'true' }, '›')))))
    : h('div', { class: 'empty' },
      h('h3', {}, 'No apps yet'),
      h('p', {}, 'An app is one Discord server, or one game or chat that calls the API. Create one to start moderating.'),
      h('a', { class: 'btn btn-primary', href: '/app/new' }, 'Create your first app'));

  clear(view,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', { tabindex: '-1' }, 'Your apps'), h('p', { class: 'muted' }, `Signed in as ${account.email}`)),
      atLimit
        ? h('a', { class: 'btn btn-ghost', href: '/app/account' }, 'Upgrade for more apps')
        : h('a', { class: 'btn btn-primary', href: '/app/new' }, '+ New app')),
    discordReason && notice('error', discordReason),
    h('section', { class: 'stats', 'aria-label': 'Plan and usage this month' },
      h('div', { class: 'card stat' },
        h('p', { class: 'stat-label' }, 'Plan'),
        h('p', { class: 'stat-value' }, limits.name ?? account.plan),
        h('p', { class: 'muted small' }, limits.priceUsd ? `$${limits.priceUsd}/month` : 'Free',
          account.currentPeriodEnd ? [' · renews ', fmtDay(account.currentPeriodEnd)] : null),
        h('a', { href: '/app/account', class: 'small' }, account.plan === 'free' ? 'See plans' : 'Manage plan')),
      h('div', { class: 'card stat' },
        h('p', { class: 'stat-label' }, `Messages checked in ${monthName(usage.month)}`),
        h('p', { class: 'stat-value' }, fmtNum(usage.messages)),
        h('p', { class: 'muted small' }, 'Keyword, spam and scam checks are unlimited.')),
      h('div', { class: 'card stat stat-wide' },
        meter('AI checks this month', usage.aiChecks, limits.aiChecksPerMonth),
        meter('Apps', usage.apps, limits.apps))),
    h('section', { 'aria-labelledby': 'apps-h' },
      h('h2', { id: 'apps-h', class: 'section-title' }, 'Apps'),
      appList,
      atLimit && apps.length > 0 && h('p', { class: 'muted small' }, `Your ${limits.name} plan allows ${fmtNum(limits.apps)} app${limits.apps === 1 ? '' : 's'}. `, h('a', { href: '/app/account' }, 'Upgrade'), ' to add more.')));
}

const monthName = (m) => (m ? new Date(`${m}-01T00:00:00Z`).toLocaleString(undefined, { month: 'long', timeZone: 'UTC' }) : 'this month');

// --- New app ---

async function newAppPage(view) {
  const name = h('input', { type: 'text', id: 'app-name', required: true, maxlength: '80', autocomplete: 'off', placeholder: 'e.g. My Game, or Community Discord' });
  const kindOption = (value, title, desc, checked) => h('label', { class: 'choice' },
    h('input', { type: 'radio', name: 'kind', value, checked }),
    h('span', { class: 'choice-body' }, h('span', { class: 'choice-title' }, title), h('span', { class: 'choice-desc' }, desc)));
  const msg = messageSlot();
  const form = h('form', { class: 'card form', novalidate: false },
    field('Name', name, 'Only you see this.'),
    h('fieldset', { class: 'choices' },
      h('legend', {}, 'What will Jef Bot moderate?'),
      kindOption('api', 'A game or other chat (API)', 'Your server sends each message to POST /v1/moderate and gets back what to do.', true),
      kindOption('discord', 'A Discord server', 'Add the Jef Bot bot to your server. It deletes, mutes and bans on its own.', false)),
    msg.el,
    h('div', { class: 'actions' },
      h('a', { class: 'btn btn-ghost', href: '/app' }, 'Cancel'),
      h('button', { type: 'submit', class: 'btn btn-primary' }, 'Create app')));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.clear();
    const kind = form.elements.kind.value;
    try {
      const out = await busy(form, () => api('POST', '/apps', { name: name.value.trim(), kind }));
      showCreated(view, out);
    } catch (err) {
      if (err.code === 'plan_limit') msg.info(err.message, ' ', h('a', { href: '/app/account' }, 'See plans'));
      else msg.error(err);
    }
  });

  clear(view,
    h('p', { class: 'crumbs' }, h('a', { href: '/app' }, 'Apps'), ' / New app'),
    h('h1', { tabindex: '-1' }, 'New app'),
    form);
  name.focus();
}

function showCreated(view, { app, appKey, discord }) {
  const appUrl = `/app/apps/${encodeURIComponent(app.id)}`;
  clear(view,
    h('p', { class: 'crumbs' }, h('a', { href: '/app' }, 'Apps'), ' / ', app.name),
    h('h1', { tabindex: '-1' }, `${app.name} is ready`),
    app.kind === 'api'
      ? h('div', { class: 'card' },
        h('h2', {}, 'Your app key'),
        appKey
          ? [
            notice('warn', h('strong', {}, 'Copy this key now. '), "It won't be shown again; if you lose it, create a new one on the app's Keys tab."),
            secretBox(appKey.secret, { label: 'Copy key' }),
            h('h3', {}, 'Try it'),
            h('p', { class: 'muted' }, 'Send each chat message to Jef Bot from your game server (never from the player\'s browser, where the key would leak):'),
            secretBox(curlExample(appKey.secret), { multiline: true, label: 'Copy' }),
            h('p', { class: 'muted small' }, 'The reply says whether to allow the message and what to do with the player (', h('code', {}, 'action.type'), ': none, delete, mute or ban). ',
              h('a', { href: '/docs/' }, 'Read the API docs'), '.'),
          ]
          : h('p', {}, 'Create a key on the app\'s Keys tab.'))
      : h('div', { class: 'card' },
        h('h2', {}, 'Add Jef Bot to your server'),
        discordLinkPanel(discord)),
    h('div', { class: 'actions' }, h('a', { class: 'btn btn-primary', href: appUrl }, 'Go to app settings')));
  view.querySelector('h1').focus();
  toast('App created');
}

// --- Account ---

async function accountPage(view, { query }) {
  const [me, { plans }, { keys }, bill] = await Promise.all([
    api('GET', '/account'), api('GET', '/plans'), api('GET', '/keys'),
    // Billing may not be mounted at all on a server without Stripe.
    api('GET', '/billing').catch(() => ({ enabled: false, hasCustomer: false })),
  ]);
  const { account, limits, usage } = me;
  const checkout = query.get('checkout');
  dropParam('checkout');

  const billingMsg = messageSlot();
  const billing = async (btn, path, body) => {
    billingMsg.clear();
    btn.disabled = true;
    try {
      const { url } = await api('POST', path, body);
      location.assign(url);
    } catch (err) {
      btn.disabled = false;
      if (err.code === 'billing_unavailable') billingMsg.info("Billing isn't set up yet. Paid plans will be available soon.");
      else if (err.code === 'no_customer') billingMsg.info('There is no billing account yet. Upgrade to a paid plan first.');
      else if (err.code === 'billing_error') billingMsg.error({ message: `The payment provider had a problem: ${err.message}. Please try again in a moment.` });
      else billingMsg.error(err);
    }
  };
  const current = plans.find((p) => p.id === account.plan);
  const onPaid = Boolean(current && current.priceUsd > 0);

  const planCard = (p) => {
    const isCurrent = p.id === account.plan;
    let action = null;
    if (isCurrent) action = h('span', { class: 'btn btn-ghost btn-block', 'aria-disabled': 'true' }, 'Current plan');
    else if (p.priceUsd === 0) {
      // Going back to free means canceling the subscription in Stripe's portal.
      if (bill.hasCustomer && onPaid) action = h('button', { type: 'button', class: 'btn btn-ghost btn-block', onclick: (e) => billing(e.currentTarget, '/billing/portal') }, 'Cancel in billing portal');
    } else if (!bill.enabled || !p.purchasable) {
      action = h('span', { class: 'btn btn-ghost btn-block', 'aria-disabled': 'true' }, 'Not available yet');
    } else {
      // Already subscribed? Checkout answers with the portal URL instead; either way, go there.
      const up = !current || p.priceUsd > current.priceUsd;
      action = h('button', { type: 'button', class: `btn ${up ? 'btn-primary' : 'btn-ghost'} btn-block`, onclick: (e) => billing(e.currentTarget, '/billing/checkout', { plan: p.id }) },
        `${up ? 'Upgrade' : 'Switch'} to ${p.name}`);
    }
    return h('li', { class: `card plan${isCurrent ? ' plan-current' : ''}`, 'aria-current': isCurrent ? 'true' : null },
      isCurrent && h('span', { class: 'plan-tag' }, 'Current'),
      h('h3', {}, p.name),
      h('p', { class: 'price' }, h('strong', {}, `$${p.priceUsd}`), ' / month'),
      h('ul', { class: 'plan-features' },
        h('li', {}, `${fmtNum(p.aiChecksPerMonth)} AI checks a month`),
        h('li', {}, `${fmtNum(p.apps)} app${p.apps === 1 ? '' : 's'}`),
        h('li', {}, `${fmtNum(p.customRules)} custom rules per app`),
        h('li', {}, `${p.historyDays} days of history`),
        p.webhooks ? h('li', {}, 'Webhooks') : h('li', { class: 'no' }, 'No webhooks'),
        h('li', {}, `${fmtNum(p.accountKeys)} account key${p.accountKeys === 1 ? '' : 's'}`)),
      action);
  };

  const checkoutBanner = h('div', { 'aria-live': 'polite' });
  if (checkout === 'success') {
    clear(checkoutBanner, notice('info', 'Thanks! Confirming your payment…'));
    waitForPlanChange(account.plan, checkoutBanner);
  } else if (checkout === 'canceled') {
    clear(checkoutBanner, notice('info', 'Checkout was canceled. Nothing was charged.'));
  }
  const periodEnd = bill.currentPeriodEnd ?? account.currentPeriodEnd;
  const status = bill.subscriptionStatus ?? account.subscriptionStatus;

  clear(view,
    h('h1', { tabindex: '-1' }, 'Account'),
    checkoutBanner,
    h('section', { class: 'card', 'aria-labelledby': 'acct-h' },
      h('h2', { id: 'acct-h' }, 'Profile'),
      h('dl', { class: 'facts' },
        h('dt', {}, 'Email'), h('dd', {}, account.email),
        h('dt', {}, 'Name'), h('dd', {}, account.name ?? '—'),
        h('dt', {}, 'Plan'), h('dd', {}, limits.name ?? account.plan, status ? h('span', { class: 'muted' }, ` (${status})`) : null),
        periodEnd && [h('dt', {}, 'Current period ends'), h('dd', {}, fmtDay(periodEnd))],
        h('dt', {}, 'Member since'), h('dd', {}, fmtDay(account.createdAt))),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-ghost', onclick: signOut }, 'Sign out'))),
    h('section', { 'aria-labelledby': 'plans-h' },
      h('div', { class: 'section-head' },
        h('h2', { id: 'plans-h', class: 'section-title' }, 'Plans'),
        bill.hasCustomer && h('button', { type: 'button', class: 'btn btn-ghost', onclick: (e) => billing(e.currentTarget, '/billing/portal') }, 'Manage billing')),
      !current && notice('info', `You're on the ${limits.name ?? account.plan} plan, which isn't sold publicly.`),
      !bill.enabled && notice('info', "Billing isn't set up yet. Paid plans will be available soon."),
      billingMsg.el,
      h('ul', { class: 'plans' }, plans.map(planCard))),
    accountKeysSection(keys, usage, limits));
}

/** After Stripe Checkout, the webhook can land a little after the redirect: poll until the plan changes. */
async function waitForPlanChange(oldPlan, banner) {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    if (!location.pathname.startsWith('/app/account')) return;
    const me = await api('GET', '/account').catch(() => null);
    if (me && me.account.plan !== oldPlan) {
      navigate('/app/account', { replace: true });
      toast(`You're now on the ${me.limits.name ?? me.account.plan} plan`);
      return;
    }
  }
  clear(banner, notice('info', "Payment received. Your plan hasn't updated yet; refresh this page in a minute. If it still hasn't changed, contact support."));
}

function accountKeysSection(keys, usage, limits) {
  const list = h('div');
  const msg = messageSlot();
  const created = h('div');
  let count = usage.accountKeys;
  const countEl = h('span', { class: 'muted small' });
  const updateCount = () => { countEl.textContent = `${count} of ${fmtNum(limits.accountKeys)} used`; };

  const drawList = () => {
    updateCount();
    clear(list, keys.length
      ? h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Name'), h('th', { scope: 'col' }, 'Key'), h('th', { scope: 'col' }, 'Created'), h('th', { scope: 'col' }, 'Last used'), h('th', {}, h('span', { class: 'sr-only' }, 'Actions')))),
        h('tbody', {}, keys.map((k) => h('tr', {},
          h('td', { 'data-label': 'Name' }, k.name),
          h('td', { 'data-label': 'Key' }, h('code', {}, `${k.prefix}…`)),
          h('td', { 'data-label': 'Created' }, timeEl(k.createdAt)),
          h('td', { 'data-label': 'Last used' }, timeEl(k.lastUsedAt)),
          h('td', { class: 'cell-actions' }, h('button', {
            type: 'button', class: 'btn btn-small btn-danger-ghost', 'aria-label': `Delete key ${k.name}`,
            onclick: async () => {
              if (!await confirmDialog({ title: 'Delete this key?', message: `Anything using "${k.name}" (${k.prefix}…) will stop working right away.`, confirmLabel: 'Delete key', danger: true })) return;
              try {
                await api('DELETE', `/keys/${encodeURIComponent(k.id)}`);
                keys = keys.filter((x) => x.id !== k.id);
                count -= 1;
                drawList();
                toast('Key deleted');
              } catch (err) { msg.error(err); }
            },
          }, 'Delete'))))))
      : h('p', { class: 'muted' }, 'No account keys yet.'));
  };

  const name = h('input', { type: 'text', id: 'acct-key-name', maxlength: '60', placeholder: 'e.g. Setup agent' });
  const form = h('form', { class: 'inline-form' },
    field('Key name', name),
    h('button', { type: 'submit', class: 'btn btn-primary' }, 'Create key'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.clear();
    try {
      const out = await busy(form, () => api('POST', '/keys', { name: name.value.trim() || undefined }));
      keys = [out.key, ...keys];
      count += 1;
      name.value = '';
      drawList();
      clear(created, h('div', { class: 'card card-inset' },
        notice('warn', h('strong', {}, 'Copy this key now. '), "It won't be shown again."),
        secretBox(out.secret, { label: 'Copy key' })));
    } catch (err) { msg.error(err); }
  });

  drawList();
  return h('section', { class: 'card', 'aria-labelledby': 'keys-h' },
    h('div', { class: 'section-head' }, h('h2', { id: 'keys-h' }, 'Account API keys'), countEl),
    h('p', { class: 'muted' }, 'An account key lets an AI agent or a script create and configure apps for you, without the dashboard. It can do anything you can here except billing, so keep it secret. ',
      h('a', { href: '/docs/agents' }, 'Setting up Jef Bot with an agent'), '.'),
    created, form, msg.el, list);
}
