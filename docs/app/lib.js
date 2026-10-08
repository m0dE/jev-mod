// Small helpers shared by the dashboard pages: building DOM safely, calling /v1, formatting.
// User-provided text only ever goes in as text nodes or attributes, never as HTML.

/** h('a', { href, class, onclick }, 'text', child, [more]) → element. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const clear = (el, ...children) => {
  el.replaceChildren();
  append(el, children);
  return el;
};

// --- API ---

export class ApiFail extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Call /v1. A 401 sends the browser to the sign-in page (unless `allow401`). */
export async function api(method, path, body, { allow401 = false } = {}) {
  let res;
  try {
    res = await fetch(`/v1${path}`, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiFail(0, 'network', "Couldn't reach the server. Check your connection and try again.");
  }
  if (res.status === 401 && !allow401) {
    toLogin();
    throw new ApiFail(401, 'unauthorized', 'Please sign in');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiFail(res.status, data?.error?.code ?? 'error', data?.error?.message ?? `Request failed (${res.status})`);
  return data;
}

export function toLogin() {
  const here = location.pathname + location.search;
  const next = here.startsWith('/app') && !here.startsWith('/app/login') ? `?next=${encodeURIComponent(here)}` : '';
  location.assign(`/app/login${next}`);
}

// --- Formatting ---

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const dayFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const relFmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const numFmt = new Intl.NumberFormat();

export const fmtNum = (n) => (n == null ? 'Unlimited' : numFmt.format(n));
export const fmtDay = (iso) => (iso ? dayFmt.format(new Date(iso)) : '—');
export const fmtDate = (iso) => (iso ? dateFmt.format(new Date(iso)) : '—');

/** "3 minutes ago" / "in 2 hours", falling back to a date for anything over a week away. */
export function fmtAgo(iso) {
  if (!iso) return 'Never';
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const units = [['second', 1000, 60], ['minute', 60_000, 60], ['hour', 3_600_000, 24], ['day', 86_400_000, 7]];
  for (const [unit, ms, max] of units) {
    if (abs < ms * max) return relFmt.format(Math.round(diff / ms), unit);
  }
  return fmtDate(iso);
}

/** A <time> element showing a relative time with the full date on hover. */
export const timeEl = (iso, { relative = true } = {}) => (iso
  ? h('time', { datetime: iso, title: fmtDate(iso) }, relative ? fmtAgo(iso) : fmtDate(iso))
  : h('span', { class: 'muted' }, '—'));

export const SEVERITIES = {
  low: 'Low: subtle rudeness, negativity, flooding chat',
  medium: 'Medium: clear insults, griefing, bullying, repeated spam',
  high: 'High: threats, slurs, self-harm incitement, scams',
};

export const kindBadge = (kind) => (kind === 'discord'
  ? h('span', { class: 'badge badge-discord' }, 'Discord')
  : h('span', { class: 'badge badge-api' }, 'API'));

export const sevBadge = (sev) => (sev ? h('span', { class: `badge sev-${sev}` }, sev) : null);

// --- Feedback ---

/** An inline message box: kind is 'error' | 'success' | 'info' | 'warn'. */
export function notice(kind, ...content) {
  return h('div', { class: `notice notice-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, ...content);
}

/** A slot that shows one message at a time (used under forms). */
export function messageSlot() {
  const el = h('div', { class: 'msg-slot', 'aria-live': 'polite' });
  return {
    el,
    error: (err) => clear(el, notice('error', err?.message ?? String(err))),
    ok: (text) => clear(el, notice('success', text)),
    info: (...c) => clear(el, notice('info', ...c)),
    clear: () => clear(el),
  };
}

let toastTimer;
export function toast(text) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Older browsers / non-secure origins.
    const ta = h('textarea', { class: 'sr-only', 'aria-hidden': 'true' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Copied to clipboard');
}

export const copyButton = (getText, label = 'Copy') => h('button', {
  type: 'button', class: 'btn btn-small btn-ghost',
  onclick: () => copyText(typeof getText === 'function' ? getText() : getText),
}, label);

/** A secret (or snippet) in a monospace box with a copy button. */
export function secretBox(value, { label = 'Copy', multiline = false } = {}) {
  return h('div', { class: `secret${multiline ? ' secret-multi' : ''}` },
    h(multiline ? 'pre' : 'code', { class: 'secret-value', tabindex: '0' }, value),
    copyButton(value, label));
}

/** Disable a form's controls while `fn` runs, so it can't be sent twice. */
export async function busy(form, fn) {
  const controls = [...form.querySelectorAll('button, input, select, textarea')].filter((c) => !c.disabled);
  controls.forEach((c) => { c.disabled = true; });
  form.setAttribute('aria-busy', 'true');
  try {
    return await fn();
  } finally {
    controls.forEach((c) => { c.disabled = false; });
    form.removeAttribute('aria-busy');
  }
}

/** A modal confirm built on <dialog>. Resolves true when confirmed. */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, typeToConfirm = null }) {
  return new Promise((resolve) => {
    const input = typeToConfirm ? h('input', { type: 'text', id: 'confirm-input', autocomplete: 'off', spellcheck: 'false' }) : null;
    const ok = h('button', { type: 'submit', class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, disabled: Boolean(typeToConfirm) }, confirmLabel);
    const dlg = h('dialog', { class: 'dialog', 'aria-labelledby': 'dlg-title' },
      h('form', { method: 'dialog' },
        h('h2', { id: 'dlg-title' }, title),
        h('p', {}, message),
        typeToConfirm && h('div', { class: 'field' },
          h('label', { for: 'confirm-input' }, 'Type ', h('strong', {}, typeToConfirm), ' to confirm'),
          input),
        h('div', { class: 'actions' },
          h('button', { type: 'submit', value: 'cancel', class: 'btn btn-ghost', formnovalidate: true }, 'Cancel'),
          ok)));
    ok.value = 'ok';
    input?.addEventListener('input', () => { ok.disabled = input.value.trim() !== typeToConfirm; });
    dlg.addEventListener('close', () => {
      resolve(dlg.returnValue === 'ok');
      dlg.remove();
    });
    document.body.append(dlg);
    dlg.showModal();
    (input ?? ok).focus();
  });
}

/** A labelled form field. `control` is an input/select/textarea with an id. */
export function field(label, control, hint) {
  const hintId = hint ? `${control.id}-hint` : null;
  if (hintId) control.setAttribute('aria-describedby', hintId);
  return h('div', { class: 'field' },
    h('label', { for: control.id }, label),
    control,
    hint && h('p', { class: 'hint', id: hintId }, hint));
}

/** A usage bar for `used` of `limit` (null = unlimited). */
export function meter(label, used, limit) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const state = !limit ? '' : pct >= 100 ? 'full' : pct >= 80 ? 'near' : '';
  const id = `m-${Math.random().toString(36).slice(2, 8)}`;
  return h('div', { class: `meter ${state}` },
    h('div', { class: 'meter-head' },
      h('span', { class: 'meter-label', id }, label),
      h('span', { class: 'meter-value' }, h('strong', {}, fmtNum(used)), ' / ', limit == null ? 'Unlimited' : fmtNum(limit))),
    limit != null && h('div', {
      class: 'meter-track', role: 'progressbar', 'aria-labelledby': id,
      'aria-valuemin': '0', 'aria-valuemax': String(limit), 'aria-valuenow': String(Math.min(used, limit)),
      'aria-valuetext': `${fmtNum(used)} of ${fmtNum(limit)} (${pct}%)`,
    }, h('div', { class: 'meter-fill', style: `width:${pct}%` })),
    state === 'near' && h('p', { class: 'meter-note' }, 'Getting close to this month\'s limit.'),
    state === 'full' && h('p', { class: 'meter-note' }, 'Limit reached: until the 1st, only the free keyword, spam and scam checks run.'));
}

/** Split "123, 456\n789" into a list of IDs. */
export const parseIds = (text) => text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

// --- Pieces used on more than one page ---

/** A ready-to-paste request to POST /v1/moderate with an app key. */
export function curlExample(secret) {
  return `curl ${location.origin}/v1/moderate \\
  -H "Authorization: Bearer ${secret}" \\
  -H "Content-Type: application/json" \\
  -d '{"userId": "player-42", "username": "Ana", "text": "hello everyone!"}'`;
}

/** How to add the bot to a server: the invite button and the /jef link fallback. */
export function discordLinkPanel(link) {
  return h('div', { class: 'link-panel' },
    link.inviteUrl
      ? [
        h('a', { class: 'btn btn-discord btn-large', href: link.inviteUrl, target: '_blank', rel: 'noopener' }, 'Add Jef Bot to your Discord server'),
        h('p', { class: 'hint' }, link.autoLink
          ? 'Pick your server on Discord. When you come back, it is linked to this app automatically.'
          : 'Pick your server on Discord, then run the command below in that server to link it to this app.'),
      ]
      : notice('warn', "Discord isn't configured on this Jef Bot server yet (the operator hasn't set a Discord client ID), so the bot can't be invited from here."),
    h('div', { class: 'fallback' },
      h('p', {}, link.inviteUrl && link.autoLink
        ? 'Already added Jef Bot, or the automatic link didn\'t work? Run this in your server (needs the Manage Server permission):'
        : 'Link command (needs the Manage Server permission):'),
      secretBox(link.linkCommand),
      h('p', { class: 'hint' }, 'This code works once and expires ', timeEl(link.expiresAt), '.')));
}

// Why "Add to server" didn't link. The callback only sends these codes, so the page never
// shows text from the URL (someone could send a link with a misleading message).
const DISCORD_ERRORS = {
  not_set_up: 'Automatic linking is not set up on this Jef Bot server. Run /jef link with your link code in your Discord server instead.',
  cancelled: 'Adding Jef Bot was cancelled.',
  no_code: "Discord didn't send back a sign-in code. Try again.",
  signed_out: 'Sign in to Jef Bot first, then use the Add to Discord button again.',
  not_owner: "That link belongs to an app on another Jef Bot account, so your server wasn't linked. Use a link from your own app.",
  expired: 'That link has expired. Get a new one from your app and try again, or use /jef link.',
  not_discord: 'Only Discord apps can be linked to a Discord server.',
  unconfirmed: "Discord didn't confirm which server Jef Bot was added to. Use /jef link in the server instead.",
  guild_taken: 'This server is already linked to a Jef Bot app on another account. Its owner has to unlink it first.',
};
export const discordError = (code) => DISCORD_ERRORS[code] ?? "Linking the Discord server didn't work. Try again, or use the /jef link command.";
