// HanVerse accounts —— /api/me：会话校验 + 统一权益计算（PayPal / 微信订单 / 兑换码 三源）
// GET /api/me  Authorization: Bearer <token>
// 后端为权益唯一事实源：登录态下前端以此为准，退款/到期自动收回。
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://www.hanverse.app,https://hanverse.app').split(',').map(s => s.trim()).filter(Boolean);
const KV_URL = process.env.KV_REST_API_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || '';
const CFG = {
  base: 'https://api-m.paypal.com',
  clientId: process.env.PAYPAL_LIVE_CLIENT_ID || 'BAA4i2iDg_ZtXgYXz8l10jUOKgBGJH8Q1iuo8DR12mElRqE8sRw5-avTFYEC8KriL-FfQedT6eoTidapCQ',
  clientSecret: process.env.PAYPAL_LIVE_CLIENT_SECRET || '',
  planId: process.env.PAYPAL_LIVE_PLAN_ID || 'P-8FA90593CM3485606NLB2AHY'
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
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Vary', 'Origin');
  }
}
function send(res, code, extra, http = 200) {
  res.statusCode = http;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(Object.assign({ code }, extra || {})));
}
async function bearerSession(req) {
  const h = String(req.headers.authorization || '');
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const sess = await kvGet('sess:' + m[1].trim());
  if (!sess || !sess.email || (sess.exp && Math.floor(Date.now() / 1000) > sess.exp)) return null;
  return sess;
}
let _ppTok = { v: '', exp: 0 };
async function ppToken() {
  const now = Date.now();
  if (_ppTok.v && now < _ppTok.exp) return _ppTok.v;
  if (!CFG.clientSecret) return '';
  const basic = Buffer.from(`${CFG.clientId}:${CFG.clientSecret}`).toString('base64');
  const r = await fetch(`${CFG.base}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  if (!r.ok) return '';
  const j = await r.json();
  _ppTok = { v: j.access_token || '', exp: now + ((j.expires_in || 28800) - 200) * 1000 };
  return _ppTok.v;
}

/* 算权益：微信订单 / 兑换码 / PayPal 三源任一有效即 Pro */
async function computeEntitlement(rec) {
  const now = Math.floor(Date.now() / 1000);
  const out = { pro: false, provia: '', plan: '', exp: 0, sources: {} };
  // 微信 Native 订单
  if (rec.wx && rec.wx.exp && now < rec.wx.exp) {
    out.pro = true; out.provia = 'wechat'; out.plan = rec.wx.sku || ''; out.exp = rec.wx.exp;
    out.sources.wechat = { orderId: rec.wx.orderId, exp: rec.wx.exp };
  }
  // 兑换码激活
  if (rec.code && rec.code.exp && now < rec.code.exp) {
    out.pro = true; out.provia = out.provia || 'code';
    out.plan = out.plan || rec.code.sku || ''; out.exp = out.exp || rec.code.exp;
    out.sources.code = { code: rec.code.code, exp: rec.code.exp };
  }
  // PayPal 订阅（缓存 1 小时）
  if (rec.sub && rec.sub.sid) {
    const stale = !rec.sub.checkedAt || (now - rec.sub.checkedAt > 3600);
    if (stale && CFG.clientSecret) {
      try {
        const tok = await ppToken();
        if (tok) {
          const r = await fetch(`${CFG.base}/v1/billing/subscriptions/${encodeURIComponent(rec.sub.sid)}`, { headers: { Authorization: `Bearer ${tok}` } });
          if (r.ok) {
            const sub = await r.json();
            const active = (sub.status === 'ACTIVE' || sub.status === 'APPROVED' ||
              (sub.status === 'CANCELLED' && sub.billing_info && sub.billing_info.next_billing_time &&
                now < Date.parse(sub.billing_info.next_billing_time) / 1000));
            rec.sub.active = !!active;
            rec.sub.checkedAt = now;
            rec.sub.nextBilling = (sub.billing_info && sub.billing_info.next_billing_time) || '';
            await kvSet('acct:' + rec.email, rec);
          }
        }
      } catch (e) { /* 网络异常不改变现状 */ }
    }
    if (rec.sub.active) {
      out.sources.paypal = { sid: rec.sub.sid, nextBilling: rec.sub.nextBilling || '' };
      if (!out.pro) { out.pro = true; out.provia = 'paypal'; out.plan = out.plan || 'P30'; }
    }
  }
  return out;
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  const sess = await bearerSession(req);
  if (!sess) return send(res, 'UNAUTHORIZED', { error: 'Please log in.' }, 401);

  // POST：绑定 PayPal sid（原 bind-paypal.js 合并于此）
  if (req.method === 'POST') {
    let body = {};
    try {
      const chunks = [];
      await new Promise((resolve) => { req.on('data', c => chunks.push(c)); req.on('end', resolve); });
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch (e) {}
    const sid = String(body.sid || '').trim();
    if (!sid || !CFG.clientSecret) return send(res, 'NOT_CONFIGURED', { ok: false });
    try {
      const tok = await ppToken();
      if (!tok) return send(res, 'ERROR', { ok: false }, 502);
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
      return send(res, 'ERROR', { ok: false }, 502);
    }
  }

  if (req.method !== 'GET') return send(res, 'BAD_METHOD', {}, 405);
  const rec = await kvGet('acct:' + sess.email);
  if (!rec) return send(res, 'UNAUTHORIZED', { error: 'Account not found.' }, 401);
  const ent = await computeEntitlement(rec);
  return send(res, 'OK', {
    email: rec.email, verified: !!rec.verified, createdAt: rec.createdAt,
    pro: ent.pro, provia: ent.provia, plan: ent.plan, exp: ent.exp, sources: ent.sources
  });
}
