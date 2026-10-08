// Sends moderation events to an app's webhook URL (paid plans). Each request is signed so
// the receiver can check it came from Jef Bot:
//   Jef-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with the app's webhook secret>

import crypto from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

// Webhook URLs are user-supplied, so never let them point the server at itself or a private
// network. IPv6 is parsed to bytes so that IPv4 addresses inside it (::ffff:127.0.0.1,
// ::127.0.0.1, 64:ff9b::7f00:1) are checked as the IPv4 address they really are.

function isPrivateV4([a, b]) {
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

/** IPv6 text → 16 bytes, or null. */
function v6Bytes(ip) {
  let text = ip.toLowerCase().split('%')[0];
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const v4 = tail[1].split('.').map(Number);
    text = `${text.slice(0, -tail[1].length)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part) => (part ? part.split(':').map((g) => parseInt(g, 16)) : []);
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const groups = halves.length === 2 ? [...head, ...Array(8 - head.length - rest.length).fill(0), ...rest] : head;
  if (groups.length !== 8 || groups.some((g) => !(g >= 0 && g <= 0xffff))) return null;
  return groups.flatMap((g) => [g >> 8, g & 0xff]);
}

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return isPrivateV4(ip.split('.').map(Number));
  const b = v6Bytes(ip);
  if (!b) return true;
  const zeros = (n) => b.slice(0, n).every((x) => x === 0);
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::a.b.c.d).
  if ((zeros(10) && b[10] === 0xff && b[11] === 0xff) || zeros(12)
    || (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0))) {
    return zeros(16) || isPrivateV4(b.slice(12));
  }
  return (b[0] & 0xfe) === 0xfc // unique local fc00::/7
    || (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) // link local fe80::/10
    || (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) // site local fec0::/10
    || b[0] === 0xff // multicast
    || (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8); // documentation
}

const hostOf = (u) => u.hostname.replace(/^\[|\]$/g, '');

/** A reason the URL can't be a webhook, or null if it's fine to save. */
export function webhookUrlProblem(url, { allowHttp = false } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return 'not a valid URL';
  }
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) return 'must start with https://';
  if (u.username || u.password) return 'must not contain a username or password';
  const host = hostOf(u);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || (net.isIP(host) && isPrivateIp(host))) {
    return 'must be a public address';
  }
  return null;
}

/** DNS lookup for http(s).request that only ever hands back public addresses. */
function publicLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return callback(err);
    const ok = addrs.filter((a) => !isPrivateIp(a.address));
    if (!ok.length || ok.length !== addrs.length) {
      return callback(Object.assign(new Error(`${hostname} resolves to a private address`), { code: 'EPRIVATE' }));
    }
    return options.all ? callback(null, ok) : callback(null, ok[0].address, ok[0].family);
  });
}

/**
 * POST `body` to `url`, connecting only to the public address that was checked (so DNS
 * can't be switched to a private one in between). Resolves to { ok, status }.
 */
export function postPinned(url, headers, body, { timeoutMs = 5_000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const host = hostOf(u);
    if (net.isIP(host) && isPrivateIp(host)) return reject(new Error('private address'));
    const req = (u.protocol === 'https:' ? https : http).request(u, {
      method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }, lookup: publicLookup, timeout: timeoutMs,
    }, (res) => {
      res.resume();
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

export function sign(secret, body, t = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

export function newWebhookSecret() {
  return `whsec_${crypto.randomBytes(24).toString('base64url')}`;
}

/** Best effort: one try, 5 second timeout, no redirects; failures are only logged. */
export function createWebhookSender({ post = postPinned, log = console } = {}) {
  return async function send(app, type, data) {
    if (!app.webhookUrl || !app.webhookSecret) return false;
    const body = JSON.stringify({ type, appId: app.id, createdAt: new Date().toISOString(), data });
    const headers = { 'Content-Type': 'application/json', 'User-Agent': 'JefBot-Webhooks/1', 'Jef-Signature': sign(app.webhookSecret, body) };
    try {
      const res = await post(app.webhookUrl, headers, body);
      if (!res.ok) log.warn(`[webhook] ${app.id} → ${res.status}`);
      return res.ok;
    } catch (err) {
      log.warn(`[webhook] ${app.id} failed: ${err.message}`);
      return false;
    }
  };
}
