// HanVerse accounts —— 绑定 PayPal 订阅到账号（onApprove 后调用，后端验真才落账）
// POST /api/bind-paypal  Authorization: Bearer <token>  body {sid}
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://www.hanverse.app,https://hanverse.app').split(',').map(s => s.trim()).filter(Boolean);
const KV_URL = process.env.KV_REST_API_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || '';
const CFG = {
  base: 'https://api-m.paypal.com',
  clientId: process.env.PAYPAL_LIVE_CLIENT_ID || 'BAA4i2iDg_ZtXgYXz8l10jUOKgBGJH8Q1iuo8DR12mElRqE8sRw5-avTFYEC8KriL-FfQedT6eoTidapCQ',
  clientSecret: process.env.PAYPAL_LIVE_CLIENT_SECRET || ''
};
async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    const j = await r.json();
    if (j && typeof j.result === 'string' && j.result) { try { return JSON.parse(j.result); } catch (e) { return null; } }
    return null;
  } catch (e) { return null; }
}
async function kvSet(key, obj) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    const value = encodeURIComponent(JSON.stringify(obj));
    const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    return r.ok;
  } catch (e) { return false; }
}
function originOf(req) { try { if (req.headers.origin) return new URL(req.headers.origin).origin; } catch (e) {} return ''; }
function applyCors(req, res) {
  const o = req.headers.origin;
  if (o && ALLOWED_ORIGINS.includes(o)) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Vary', 'Origin');
  }
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function send(res, code, extra, http = 200) {
  res.statusCode = http; res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(Object.assign({ code }, extra || {})));
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return send(res, 'BAD_METHOD', {}, 405);
  const h = String(req.headers.authorization || '');
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return send(res, 'UNAUTHORIZED', {}, 401);
  const sess = await kvGet('sess:' + m[1].trim());
  if (!sess || !sess.email) return send(res, 'UNAUTHORIZED', {}, 401);
  let body = {};
  try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { return send(res, 'BAD_REQUEST'); }
  const sid = String(body.sid || '').trim();
  if (!sid) return send(res, 'NO_SID');

  if (!CFG.clientSecret) return send(res, 'NOT_CONFIGURED', { ok: false });
  try {
    const basic = Buffer.from(`${CFG.clientId}:${CFG.clientSecret}`).toString('base64');
    const t = await fetch(`${CFG.base}/v1/oauth2/token`, {
      method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials'
    });
    const tj = await t.json();
    const tok = tj.access_token;
    const r = await fetch(`${CFG.base}/v1/billing/subscriptions/${encodeURIComponent(sid)}`, { headers: { Authorization: `Bearer ${tok}` } });
    if (!r.ok) return send(res, 'SUB_NOT_FOUND', { ok: false });
    const sub = await r.json();
    const active = sub.status === 'ACTIVE' || sub.status === 'APPROVED';
    const rec = await kvGet('acct:' + sess.email);
    if (rec) {
      rec.sub = { sid, active, checkedAt: Math.floor(Date.now() / 1000), nextBilling: (sub.billing_info && sub.billing_info.next_billing_time) || '' };
      await kvSet('acct:' + sess.email, rec);
    }
    return send(res, 'OK', { ok: true, active });
  } catch (e) {
    return send(res, 'ERROR', { ok: false, detail: String(e.message || '').slice(0, 120) }, 502);
  }
}
