// HanVerse accounts —— /api/me：会话校验 + 统一权益计算（PayPal / 微信订单 / 兑换码 三源）
// GET /api/me  Authorization: Bearer <token>
// 后端为权益唯一事实源：登录态下前端以此为准，退款/到期自动收回。
import { createHmac, randomBytes } from 'node:crypto';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://www.hanverse.app,https://hanverse.app').split(',').map(s => s.trim()).filter(Boolean);
const KV_URL = process.env.KV_REST_API_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || '';
const CODE_SIGNING_SECRET = process.env.CODE_SIGNING_SECRET || '';
const CODE_ALPH = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_SKU_DAYS = { M30: 30, Y365: 365 };
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
async function kvKeys(pattern) {
  if (!KV_URL || !KV_TOKEN) return [];
  try {
    const r = await fetch(`${KV_URL}/keys/${encodeURIComponent(pattern)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    const j = await r.json();
    if (j && Array.isArray(j.result)) return j.result;
    return [];
  } catch (e) { return []; }
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

/* ---- 管理员：生成 HMAC 兑换码（与 gen_codes_hmac.py 一致；激活时 redeem-code.js 验签） ---- */
function hmacSig6(signed) {
  if (!CODE_SIGNING_SECRET) return '';
  const h = createHmac('sha256', CODE_SIGNING_SECRET).update(signed).digest();
  let n = h.readUInt32BE(0);
  let out = '';
  for (let i = 0; i < 6; i++) { out += CODE_ALPH[n % 31]; n = Math.floor(n / 31); }
  return out;
}
function makeHmacCode(sku) {
  const body = [];
  for (let i = 0; i < 8; i++) body.push(CODE_ALPH[randomBytes(1)[0] % 31]);
  const b = body.join('');
  return `HV-${sku}-${b}-${hmacSig6(`HV-${sku}-${b}`)}`;
}
/* 管理员统计：用户数 / Pro 数 / 激活兑换码数 */
async function adminStats() {
  const acctKeys = await kvKeys('acct:*');
  let pro = 0;
  for (const k of acctKeys) {
    const email = k.slice(5);
    const rec = await kvGet('acct:' + email);
    if (!rec) continue;
    const ent = await computeEntitlement(rec);
    if (ent.pro) pro++;
  }
  const rcKeys = await kvKeys('rc:hmac:*');
  const wlKeys = await kvKeys('wl:*');
  return {
    users: acctKeys.length,
    proUsers: pro,
    activatedCodes: rcKeys.length,
    waitlist: wlKeys.length
  };
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
  // 推荐奖励 bonus：叠加为最长到期，唯一来源时同样解锁 Pro
  if (rec.bonus && rec.bonus.exp && now < rec.bonus.exp) {
    out.sources.bonus = { exp: rec.bonus.exp };
    if (!out.pro) { out.pro = true; out.provia = 'bonus'; out.plan = 'BONUS'; }
  }
  // 7 天免费试用（注册赠送）：有效期内解锁 Pro；付费/奖励来源优先（provia 不被 trial 覆盖），到期自动失效
  if (rec.trial && rec.trial.exp && now < rec.trial.exp) {
    out.sources.trial = { exp: rec.trial.exp };
    if (!out.pro) { out.pro = true; out.provia = 'trial'; out.plan = 'TRIAL7'; }
  }
  // 取所有来源中最晚到期作为展示 exp（bonus 叠加在付费权益之上）
  let maxExp = 0;
  for (const k in out.sources) {
    const e = Number(out.sources[k].exp) || 0;
    if (e > maxExp) maxExp = e;
  }
  if (maxExp) out.exp = maxExp;
  return out;
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  const sess = await bearerSession(req);
  if (!sess) return send(res, 'UNAUTHORIZED', { error: 'Please log in.' }, 401);

  // POST：管理员动作（仅 role=master）或绑定 PayPal sid（原 bind-paypal.js 合并于此）
  if (req.method === 'POST') {
    let body = {};
    try {
      const chunks = [];
      await new Promise((resolve) => { req.on('data', c => chunks.push(c)); req.on('end', resolve); });
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch (e) {}
    const meRec = await kvGet('acct:' + sess.email);
    const isMaster = !!(meRec && meRec.role === 'master');
    const action = String(body.action || '');
    if (action === 'admin_stats') {
      if (!isMaster) return send(res, 'FORBIDDEN', { error: 'Admin only.' }, 403);
      const stats = await adminStats();
      return send(res, 'OK', { stats });
    }
    if (action === 'admin_gen_codes') {
      if (!isMaster) return send(res, 'FORBIDDEN', { error: 'Admin only.' }, 403);
      if (!CODE_SIGNING_SECRET) return send(res, 'NOT_CONFIGURED', { error: 'Code signing not configured.' }, 503);
      const sku = body.sku === 'Y365' ? 'Y365' : 'M30';
      const n = Math.min(Number(body.n) || 10, 100);
      const codes = [];
      for (let i = 0; i < n; i++) codes.push(makeHmacCode(sku));
      return send(res, 'OK', { sku, codes });
    }
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
    role: rec.role || 'user',
    pro: ent.pro, provia: ent.provia, plan: ent.plan, exp: ent.exp, sources: ent.sources
  });
}
