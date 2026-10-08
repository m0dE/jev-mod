// One app's page (/app/apps/:id/:tab): overview, rules, keys, webhook, Discord settings,
// history, users and the danger zone. Each tab is its own path so it can be linked to.

import {
  h, clear, api, notice, messageSlot, busy, field, kindBadge, sevBadge, secretBox, copyButton, toast,
  confirmDialog, curlExample, discordLinkPanel, discordError, fmtNum, fmtDate, timeEl, parseIds, SEVERITIES,
} from './lib.js';
import { navigate, dropParam } from './app.js';

const TAB_LABELS = {
  overview: 'Overview', rules: 'Rules', keys: 'Keys', webhook: 'Webhook', discord: 'Discord settings',
  history: 'History', users: 'Users', danger: 'Danger zone',
};
const TABS = { overview: overviewTab, rules: rulesTab, keys: keysTab, webhook: webhookTab, discord: discordTab, history: historyTab, users: usersTab, danger: dangerTab };

export async function appPage(view, { params: [appId, tabParam], query, setTitle }) {
  const [{ app }, me] = await Promise.all([api('GET', `/apps/${encodeURIComponent(appId)}`), api('GET', '/account')]);
  const base = `/app/apps/${encodeURIComponent(app.id)}`;
  const tabs = Object.keys(TAB_LABELS).filter((t) => (t !== 'keys' || app.kind === 'api') && (t !== 'discord' || app.kind === 'discord'));
  const tab = tabs.includes(tabParam ?? 'overview') ? (tabParam ?? 'overview') : null;
  setTitle(app.name);

  // Banners from Discord's "Add to server" round trip.
  const discord = query.get('discord');
  const reason = query.get('reason');
  dropParam('discord');
  dropParam('reason');

  const title = h('h1', { tabindex: '-1' }, app.name);
  const ctx = {
    app, me, base, query,
    setName(name) { app.name = name; title.textContent = name; setTitle(name); },
    reload: () => navigate(location.pathname + location.search, { replace: true }),
  };
  const body = h('div', { class: 'tab-body' });
  if (tab) await TABS[tab](body, ctx);
  else clear(body, notice('error', 'There is no such section. '), h('a', { href: base }, 'Back to the overview'));

  clear(view,
    h('p', { class: 'crumbs' }, h('a', { href: '/app' }, 'Apps'), ' / ', app.name),
    h('div', { class: 'page-head' },
      h('div', { class: 'title-row' }, title, kindBadge(app.kind))),
    discord === 'linked' && notice('success', 'Your Discord server is linked. Jef Bot is now moderating it.'),
    discord === 'error' && notice('error', discordError(reason)),
    h('nav', { class: 'tabs', 'aria-label': 'App sections' },
      tabs.map((t) => h('a', { href: t === 'overview' ? base : `${base}/${t}`, 'aria-current': t === tab ? 'page' : null, class: t === 'danger' ? 'tab-danger' : null }, TAB_LABELS[t]))),
    body);
}

// --- Overview ---

async function overviewTab(el, ctx) {
  const { app, base } = ctx;
  const name = h('input', { type: 'text', id: 'rename', value: app.name, required: true, maxlength: '80' });
  const msg = messageSlot();
  const rename = h('form', { class: 'inline-form' },
    field('App name', name),
    h('button', { type: 'submit', class: 'btn btn-primary' }, 'Rename'));
  rename.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.clear();
    try {
      const out = await busy(rename, () => api('PATCH', `/apps/${encodeURIComponent(app.id)}`, { name: name.value.trim() }));
      ctx.setName(out.app.name);
      toast('Renamed');
    } catch (err) { msg.error(err); }
  });

  clear(el,
    h('section', { class: 'card' },
      h('h2', {}, 'Details'),
      h('dl', { class: 'facts' },
        h('dt', {}, 'Kind'), h('dd', {}, app.kind === 'discord' ? 'Discord server' : 'Game or other chat (API)'),
        h('dt', {}, 'App ID'), h('dd', {}, h('code', {}, app.id), ' ', copyButton(app.id)),
        h('dt', {}, 'Created'), h('dd', {}, fmtDate(app.createdAt)),
        h('dt', {}, 'Custom rules'), h('dd', {}, h('a', { href: `${base}/rules` }, String(app.rules?.length ?? 0)))),
      rename, msg.el),
    app.kind === 'discord' ? discordLinkSection(ctx) : apiQuickStart(ctx));
}

function discordLinkSection(ctx) {
  const { app } = ctx;
  const slot = h('div');
  const msg = messageSlot();
  const linked = Boolean(app.discordGuildId);

  const link = h('button', {
    type: 'button', class: 'btn btn-primary',
    onclick: async () => {
      msg.clear();
      link.disabled = true;
      try {
        clear(slot, discordLinkPanel(await api('POST', `/apps/${encodeURIComponent(app.id)}/discord/link`)));
        link.textContent = 'Get a new link';
      } catch (err) { msg.error(err); } finally { link.disabled = false; }
    },
  }, linked ? 'Relink to another server' : 'Link a Discord server');

  const unlink = linked && h('button', {
    type: 'button', class: 'btn btn-danger-ghost',
    onclick: async () => {
      if (!await confirmDialog({ title: 'Unlink this server?', message: 'Jef Bot will stop moderating it until you link it again. Strikes and history are kept.', confirmLabel: 'Unlink', danger: true })) return;
      try {
        await api('DELETE', `/apps/${encodeURIComponent(app.id)}/discord`);
        toast('Server unlinked');
        ctx.reload();
      } catch (err) { msg.error(err); }
    },
  }, 'Unlink');

  return h('section', { class: 'card' },
    h('h2', {}, 'Discord server'),
    linked
      ? h('p', {}, h('span', { class: 'status status-ok' }, 'Linked'), ' to server ID ', h('code', {}, app.discordGuildId))
      : h('p', {}, h('span', { class: 'status status-warn' }, 'Not linked'), ' Add Jef Bot to your server to start moderating.'),
    h('div', { class: 'actions actions-start' }, link, unlink),
    msg.el, slot,
    h('p', { class: 'hint' }, 'In Discord, drag the Jef Bot role above your members\' roles, or it can\'t mute them.'));
}

function apiQuickStart(ctx) {
  return h('section', { class: 'card' },
    h('h2', {}, 'Quick start'),
    h('p', { class: 'muted' }, 'From your game server, send each chat message to Jef Bot with one of this app\'s ',
      h('a', { href: `${ctx.base}/keys` }, 'keys'), ':'),
    secretBox(curlExample('YOUR_APP_KEY'), { multiline: true }),
    h('p', { class: 'muted small' }, 'Act on ', h('code', {}, 'allow'), ' and ', h('code', {}, 'action'),
      ' in the reply. ', h('a', { href: '/docs/' }, 'Full API docs'), '.'));
}

// --- Rules ---

async function rulesTab(el, ctx) {
  const { app, me } = ctx;
  let rules = app.rules ?? (await api('GET', `/apps/${encodeURIComponent(app.id)}/rules`)).rules;
  const limit = me.limits.customRules;
  const list = h('div');
  const countEl = h('span', { class: 'muted small' });
  const msg = messageSlot();

  const draw = () => {
    countEl.textContent = `${rules.length} of ${fmtNum(limit)} used`;
    clear(list, rules.length
      ? h('ul', { class: 'rule-list' }, rules.map((r) => h('li', { class: 'rule' },
        sevBadge(r.severity),
        h('span', { class: 'rule-text' }, r.text),
        h('button', {
          type: 'button', class: 'btn btn-small btn-danger-ghost', 'aria-label': `Remove rule: ${r.text}`,
          onclick: async () => {
            try {
              await api('DELETE', `/apps/${encodeURIComponent(app.id)}/rules/${r.id}`);
              rules = rules.filter((x) => x.id !== r.id);
              app.rules = rules;
              draw();
              toast('Rule removed');
            } catch (err) { msg.error(err); }
          },
        }, 'Remove'))))
      : h('p', { class: 'muted' }, 'No custom rules yet. The built-in rules (no insults, harassment, hate, threats, griefing, spam or scams) always apply.'));
    submit.disabled = limit != null && rules.length >= limit;
  };

  const text = h('textarea', { id: 'rule-text', rows: '2', maxlength: '300', required: true, placeholder: 'e.g. No asking for free items or trades' });
  const counter = h('span', { class: 'counter', 'aria-live': 'polite' }, '0 / 300');
  text.addEventListener('input', () => { counter.textContent = `${text.value.length} / 300`; });
  const sev = severitySelect('rule-sev', 'low');
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Add rule');
  const form = h('form', { class: 'stack-form' },
    field('Rule, in plain words', text, 'Jev judges what a message means, so rephrasings are caught too.'),
    counter,
    field('Severity if broken', sev),
    h('div', { class: 'actions actions-start' }, submit));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.clear();
    try {
      const { rule } = await busy(form, () => api('POST', `/apps/${encodeURIComponent(app.id)}/rules`, { text: text.value.trim(), severity: sev.value }));
      rules = [...rules, rule];
      app.rules = rules;
      text.value = '';
      counter.textContent = '0 / 300';
      draw();
      toast('Rule added');
    } catch (err) { msg.error(err); }
  });

  draw();
  clear(el, h('section', { class: 'card' },
    h('div', { class: 'section-head' }, h('h2', {}, 'Custom rules'), countEl),
    h('p', { class: 'muted' }, 'Your own rules, on top of the built-in ones.',
      limit != null && rules.length >= limit ? [' You\'ve reached your plan\'s limit. ', h('a', { href: '/app/account' }, 'Upgrade'), ' for more.'] : null),
    list, msg.el, form));
}

function severitySelect(id, value) {
  return h('select', { id }, Object.entries(SEVERITIES).map(([k, label]) => h('option', { value: k, selected: k === value }, label)));
}

// --- Keys (API apps) ---

async function keysTab(el, ctx) {
  const { app } = ctx;
  const path = `/apps/${encodeURIComponent(app.id)}/keys`;
  let { keys } = await api('GET', path);
  const list = h('div');
  const created = h('div');
  const msg = messageSlot();

  const draw = () => clear(list, keys.length
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
              await api('DELETE', `${path}/${encodeURIComponent(k.id)}`);
              keys = keys.filter((x) => x.id !== k.id);
              draw();
              toast('Key deleted');
            } catch (err) { msg.error(err); }
          },
        }, 'Delete'))))))
    : h('p', { class: 'muted' }, 'No keys. Create one to call the API.'));

  const name = h('input', { type: 'text', id: 'app-key-name', maxlength: '60', placeholder: 'e.g. Production server' });
  const form = h('form', { class: 'inline-form' }, field('Key name', name), h('button', { type: 'submit', class: 'btn btn-primary' }, 'Create key'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.clear();
    try {
      const out = await busy(form, () => api('POST', path, { name: name.value.trim() || undefined }));
      keys = [out.key, ...keys];
      name.value = '';
      draw();
      clear(created, h('div', { class: 'card card-inset' },
        notice('warn', h('strong', {}, 'Copy this key now. '), "It won't be shown again."),
        secretBox(out.secret, { label: 'Copy key' }),
        h('details', {}, h('summary', {}, 'Example request'), secretBox(curlExample(out.secret), { multiline: true }))));
    } catch (err) { msg.error(err); }
  });

  draw();
  clear(el, h('section', { class: 'card' },
    h('h2', {}, 'App keys'),
    h('p', { class: 'muted' }, 'App keys can only moderate and read this app\'s users, rules and history. Use them on your game server, never in a game client.'),
    created, form, msg.el, list));
}

// --- Webhook ---

async function webhookTab(el, ctx) {
  const { app, me } = ctx;
  if (!me.limits.webhooks) {
    clear(el, h('section', { class: 'card upsell' },
      h('h2', {}, 'Webhooks'),
      h('p', {}, 'Get a signed HTTP POST to your server every time Jef Bot acts, so your game can mute players, log actions or alert staff.'),
      h('p', { class: 'muted' }, `Webhooks need a paid plan. You're on ${me.limits.name}.`),
      h('a', { class: 'btn btn-primary', href: '/app/account' }, 'See plans')));
    return;
  }
  const url = h('input', { type: 'url', id: 'webhook-url', value: app.webhookUrl ?? '', placeholder: 'https://example.com/jef-webhook', inputmode: 'url' });
  const msg = messageSlot();
  const secretSlot = h('div');
  const form = h('form', { class: 'inline-form' },
    field('Webhook URL', url, 'Leave empty to turn webhooks off.'),
    h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.clear();
    try {
      const out = await busy(form, () => api('PATCH', `/apps/${encodeURIComponent(app.id)}`, { webhookUrl: url.value.trim() || null }));
      Object.assign(app, { webhookUrl: out.app.webhookUrl, webhookSecret: out.app.webhookSecret });
      drawSecret();
      toast(app.webhookUrl ? 'Webhook saved' : 'Webhook turned off');
    } catch (err) { msg.error(err); }
  });

  function drawSecret() {
    if (!app.webhookSecret) return clear(secretSlot);
    let shown = false;
    const value = h('code', { class: 'secret-value' });
    const toggle = h('button', { type: 'button', class: 'btn btn-small btn-ghost', 'aria-pressed': 'false' }, 'Reveal');
    const paint = () => {
      value.textContent = shown ? app.webhookSecret : '•'.repeat(32);
      toggle.textContent = shown ? 'Hide' : 'Reveal';
      toggle.setAttribute('aria-pressed', String(shown));
    };
    toggle.addEventListener('click', () => { shown = !shown; paint(); });
    paint();
    const rotate = h('button', {
      type: 'button', class: 'btn btn-small btn-danger-ghost',
      onclick: async () => {
        if (!await confirmDialog({ title: 'Rotate the signing secret?', message: 'The old secret stops working immediately. Update your server with the new one.', confirmLabel: 'Rotate', danger: true })) return;
        try {
          const out = await api('POST', `/apps/${encodeURIComponent(app.id)}/webhook-secret`);
          app.webhookSecret = out.webhookSecret;
          drawSecret();
          toast('Secret rotated');
        } catch (err) { msg.error(err); }
      },
    }, 'Rotate');
    clear(secretSlot,
      h('h3', {}, 'Signing secret'),
      h('div', { class: 'secret' }, value, toggle, copyButton(() => app.webhookSecret), rotate),
      h('p', { class: 'hint' }, 'Each request has a ', h('code', {}, 'Jef-Signature: t=<unix>,v1=<hex>'),
        ' header: the HMAC-SHA256 of ', h('code', {}, '"<t>.<raw body>"'), ' keyed with this secret. Check it before trusting a request.'));
  }

  drawSecret();
  clear(el, h('section', { class: 'card' },
    h('h2', {}, 'Webhook'),
    h('p', { class: 'muted' }, 'Jef Bot POSTs ', h('code', {}, 'moderation.action'), ', ', h('code', {}, 'moderation.manual'), ' and ',
      h('code', {}, 'moderation.pardon'), ' events here as JSON.'),
    form, msg.el, secretSlot));
}

// --- Discord settings ---

async function discordTab(el, ctx) {
  const { app } = ctx;
  const s = app.settings ?? {};
  const modLog = h('input', { type: 'text', id: 'modlog', inputmode: 'numeric', value: s.modLogChannelId ?? '', placeholder: 'e.g. 1234567890123456789', autocomplete: 'off' });
  const ignored = h('textarea', { id: 'ignored', rows: '2', placeholder: 'Channel IDs, separated by commas or new lines' });
  ignored.value = (s.ignoredChannelIds ?? []).join('\n');
  const exempt = h('textarea', { id: 'exempt', rows: '2', placeholder: 'Role IDs, separated by commas or new lines' });
  exempt.value = (s.exemptRoleIds ?? []).join('\n');
  const msg = messageSlot();
  const form = h('form', { class: 'stack-form' },
    field('Mod log channel ID', modLog, 'Where Jef Bot posts every action for your staff. You can also set it with /modlog in Discord.'),
    field('Ignored channel IDs', ignored, 'Messages in these channels are never moderated.'),
    field('Exempt role IDs', exempt, 'Members with any of these roles are never moderated. Staff and the owner are always exempt.'),
    h('div', { class: 'actions actions-start' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save settings')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.clear();
    const ignoredIds = parseIds(ignored.value);
    const exemptIds = parseIds(exempt.value);
    try {
      const out = await busy(form, () => api('PATCH', `/apps/${encodeURIComponent(app.id)}`, {
        settings: {
          modLogChannelId: modLog.value.trim() || null,
          ignoredChannelIds: ignoredIds.length ? ignoredIds : null,
          exemptRoleIds: exemptIds.length ? exemptIds : null,
        },
      }));
      app.settings = out.app.settings;
      msg.ok('Settings saved.');
    } catch (err) { msg.error(err); }
  });
  clear(el, h('section', { class: 'card' },
    h('h2', {}, 'Discord settings'),
    h('p', { class: 'muted' }, 'To copy an ID in Discord, turn on Developer Mode (User Settings → Advanced), then right-click a channel or role and choose Copy ID.'),
    form, msg.el));
}

// --- History ---

const TYPE_LABELS = { action: 'Action', watch: 'Watching', manual: 'Manual', pardon: 'Pardon' };

async function historyTab(el, ctx) {
  const { app, base, me } = ctx;
  const userFilter = ctx.query.get('user') ?? '';
  const userInput = h('input', { type: 'text', id: 'history-user', value: userFilter, placeholder: 'Any user', autocomplete: 'off' });
  const filter = h('form', { class: 'inline-form', role: 'search' },
    field('Filter by user ID', userInput),
    h('button', { type: 'submit', class: 'btn btn-ghost' }, 'Filter'),
    userFilter && h('a', { class: 'btn btn-ghost', href: `${base}/history` }, 'Clear'));
  filter.addEventListener('submit', (e) => {
    e.preventDefault();
    const u = userInput.value.trim();
    navigate(`${base}/history${u ? `?user=${encodeURIComponent(u)}` : ''}`, { replace: true });
  });

  const list = h('ol', { class: 'events' });
  const msg = messageSlot();
  const more = h('button', { type: 'button', class: 'btn btn-ghost' }, 'Load older');
  const empty = h('p', { class: 'muted', hidden: true }, userFilter ? 'No history for this user.' : 'Nothing has happened yet. Actions Jef Bot takes will show up here.');
  const LIMIT = 50;
  let before = null;

  async function load() {
    msg.clear();
    more.disabled = true;
    try {
      const qs = new URLSearchParams({ limit: String(LIMIT) });
      if (before != null) qs.set('before', String(before));
      if (userFilter) qs.set('userId', userFilter);
      const { events, nextBefore } = await api('GET', `/apps/${encodeURIComponent(app.id)}/events?${qs}`);
      list.append(...events.map((ev) => eventItem(ev, base)));
      before = nextBefore;
      more.hidden = events.length < LIMIT;
      empty.hidden = list.children.length > 0;
    } catch (err) { msg.error(err); } finally { more.disabled = false; }
  }
  more.addEventListener('click', load);
  await load();

  clear(el, h('section', { class: 'card' },
    h('h2', {}, 'History'),
    h('p', { class: 'muted small' }, `Kept for ${me.limits.historyDays} days on your plan. Clean messages are never stored.`),
    filter, list, empty, msg.el, h('div', { class: 'actions actions-start' }, more)));
}

function eventItem(ev, base) {
  const userLink = ev.userId && h('a', { href: `${base}/users?user=${encodeURIComponent(ev.userId)}` },
    ev.username ? `${ev.username}` : ev.userId);
  return h('li', { class: `event event-${ev.type}` },
    h('div', { class: 'event-head' },
      h('span', { class: `badge type-${ev.type}` }, TYPE_LABELS[ev.type] ?? ev.type),
      ev.action && h('strong', {}, ev.action),
      sevBadge(ev.severity),
      ev.category && h('span', { class: 'muted' }, ev.category),
      h('span', { class: 'event-time' }, timeEl(ev.at))),
    h('div', { class: 'event-body' },
      userLink && h('p', {}, 'User: ', userLink, ev.username && ev.userId ? h('span', { class: 'muted' }, ` (${ev.userId})`) : null,
        ev.room ? h('span', { class: 'muted' }, ` in ${ev.room}`) : null),
      ev.excerpt && h('blockquote', {}, ev.excerpt),
      ev.reason && h('p', {}, ev.reason),
      h('p', { class: 'muted small' },
        ev.strikes != null ? `${ev.strikes} active strike${ev.strikes === 1 ? '' : 's'}` : null,
        ev.strikes != null && (ev.by || ev.source) ? ' · ' : null,
        ev.by ? `by ${ev.by}` : ev.source ? `via ${ev.source}` : null)));
}

// --- Users ---

async function usersTab(el, ctx) {
  const { app, base } = ctx;
  const appPath = `/apps/${encodeURIComponent(app.id)}`;
  const userInput = h('input', { type: 'text', id: 'user-id', required: true, value: ctx.query.get('user') ?? '', autocomplete: 'off', placeholder: app.kind === 'discord' ? 'Discord user ID' : 'Your game\'s user ID' });
  const lookup = h('form', { class: 'inline-form', role: 'search' },
    field('User ID', userInput),
    h('button', { type: 'submit', class: 'btn btn-primary' }, 'Look up'));
  const result = h('div', { 'aria-live': 'polite' });
  const msg = messageSlot();

  lookup.addEventListener('submit', (e) => {
    e.preventDefault();
    const u = userInput.value.trim();
    if (!u) return;
    history.replaceState(null, '', `${base}/users?user=${encodeURIComponent(u)}`);
    show(u);
  });

  async function show(userId, note) {
    msg.clear();
    let s;
    try {
      s = await api('GET', `${appPath}/users/${encodeURIComponent(userId)}`);
    } catch (err) {
      clear(result);
      return msg.error(err);
    }
    const uPath = `${appPath}/users/${encodeURIComponent(userId)}`;

    const reason = h('input', { type: 'text', id: 'warn-reason', required: true, maxlength: '300', placeholder: 'What they did' });
    const sev = severitySelect('warn-sev', 'medium');
    const warnForm = h('form', { class: 'stack-form' },
      field('Reason', reason, 'Shown to the user and in history.'),
      field('Severity', sev),
      h('div', { class: 'actions actions-start' }, h('button', { type: 'submit', class: 'btn btn-danger' }, 'Warn and punish')));
    warnForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const out = await busy(warnForm, () => api('POST', `${uPath}/warn`, { reason: reason.value.trim(), severity: sev.value }));
        show(userId, `Warned. Punishment: ${out.action?.label ?? 'none'}${app.kind === 'api' ? ' (your game applies it)' : ''}.`);
      } catch (err) { msg.error(err); }
    });

    const count = h('input', { type: 'number', id: 'pardon-count', min: '1', step: '1', inputmode: 'numeric', placeholder: 'All' });
    const pardonForm = h('form', { class: 'stack-form' },
      field('How many strikes to remove', count, 'The most recent first. Leave empty to remove all.'),
      h('div', { class: 'actions actions-start' }, h('button', { type: 'submit', class: 'btn btn-ghost', disabled: s.strikes === 0 }, 'Pardon')));
    pardonForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const n = count.value ? Number(count.value) : undefined;
      try {
        const out = await busy(pardonForm, () => api('POST', `${uPath}/pardon`, n ? { count: n } : {}));
        show(userId, `Removed ${out.removed} strike${out.removed === 1 ? '' : 's'}.`);
      } catch (err) { msg.error(err); }
    });

    clear(result,
      note && notice('success', note),
      h('section', { class: 'card' },
        h('div', { class: 'section-head' },
          h('h2', {}, 'User ', h('code', {}, s.userId)),
          h('a', { href: `${base}/history?user=${encodeURIComponent(s.userId)}`, class: 'small' }, 'View history')),
        h('p', { class: 'big-number' }, h('strong', {}, String(s.strikes)), ` active strike${s.strikes === 1 ? '' : 's'}`),
        h('h3', {}, 'Their next offense would get'),
        h('table', { class: 'table compact' },
          h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Severity'), h('th', { scope: 'col' }, 'Punishment'))),
          h('tbody', {}, Object.entries(s.next).map(([sv, step]) => h('tr', {}, h('td', {}, sevBadge(sv)), h('td', {}, step.label))))),
        s.active.length > 0 && [
          h('h3', {}, 'Active strikes'),
          h('ul', { class: 'strikes' }, s.active.map((st) => h('li', {},
            h('div', { class: 'event-head' }, sevBadge(st.severity), st.category && h('span', { class: 'muted' }, st.category),
              h('span', { class: 'event-time' }, timeEl(st.at))),
            st.excerpt && h('blockquote', {}, st.excerpt),
            st.reason && h('p', {}, st.reason),
            h('p', { class: 'muted small' }, `Counts until ${fmtDate(st.until)}`, st.by && st.by !== 'auto' ? ` · by ${st.by}` : ''))))],
      ),
      h('div', { class: 'two-col' },
        h('section', { class: 'card' }, h('h2', {}, 'Warn'), h('p', { class: 'muted small' }, 'Adds a strike and punishes on the same ladder as automatic actions.'), warnForm),
        h('section', { class: 'card' }, h('h2', {}, 'Pardon'), pardonForm)));
  }

  clear(el, h('section', { class: 'card' },
    h('h2', {}, 'Look up a user'),
    h('p', { class: 'muted' }, 'See a user\'s active strikes and what their next offense would get, warn them by hand, or pardon them.'),
    lookup, msg.el), result);
  if (userInput.value) await show(userInput.value.trim());
}

// --- Danger zone ---

async function dangerTab(el, ctx) {
  const { app } = ctx;
  const msg = messageSlot();
  clear(el, h('section', { class: 'card card-danger' },
    h('h2', {}, 'Delete this app'),
    h('p', {}, 'This deletes the app with its rules, keys, strikes and history. ',
      app.kind === 'discord' ? 'Jef Bot stops moderating the linked server. ' : 'Its keys stop working right away. ',
      'This can\'t be undone.'),
    h('button', {
      type: 'button', class: 'btn btn-danger',
      onclick: async () => {
        if (!await confirmDialog({ title: `Delete ${app.name}?`, message: 'Everything about this app is deleted for good.', confirmLabel: 'Delete app', danger: true, typeToConfirm: app.name })) return;
        try {
          await api('DELETE', `/apps/${encodeURIComponent(app.id)}`);
          toast('App deleted');
          navigate('/app');
        } catch (err) { msg.error(err); }
      },
    }, 'Delete app'),
    msg.el));
}
