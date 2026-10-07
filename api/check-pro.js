// HanVerse Pro —— 订阅状态查询（Vercel Node Serverless Function）
//
// 前端在两个时机调用（凭 PayPal subscription_id）：
//   1) PayPal onApprove：付款当下实时确认是否有效订阅 → 自动解锁；
//   2) 之后每天打开页面一次：联网复查，退款 / 拒付 / 过期 → 自动收回 Pro。
// 数据来源：实时回查 PayPal 订阅接口（权威）+ KV 中的“退款/拒付/过期”强吊销标记（webhook 写入）。
//
// 机密：仅 PAYPAL_LIVE_CLIENT_SECRET 必须在 Vercel 环境变量配置；
// client_id / plan_id / webhook_id 为半公开（前端 JS SDK 本就暴露），内置默认值、可用环境变量覆盖。

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://www.hanverse.app,https://hanverse.app')
  .split(',').map(s => s.trim()).filter(Boolean);
const KV_URL = process.env.KV_REST_API_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || '';

const CONFIGS = {
  live: {
    base: 'https://api-m.paypal.com',
    clientId: process.env.PAYPAL_LIVE_CLIENT_ID || 'BAA4i2iDg_ZtXgYXz8l10jUOKgBGJH8Q1iuo8DR12mElRqE8sRw5-avTFYEC8KriL-FfQedT6eoTidapCQ',
    clientSecret: process.env.PAYPAL_LIVE_CLIENT_SECRET || '',
    // 现网三档计划（半公开，前端 SDK 本就暴露）；订阅必须命中其一，防止把其它产品订阅误判为已购
    plans: {
      monthly: process.env.PAYPAL_PLAN_MONTHLY || 'P-4V3472025F230033KNLCJ4HI',
      promo:   process.env.PAYPAL_PLAN_PROMO   || 'P-34B9575259554822PNLCJ5BY',
      annual:  process.env.PAYPAL_PLAN_ANNUAL  || 'P-31814090U8192141DNLCJ55I'
    }
  },
  sandbox: {
    base: 'https://api-m.sandbox.paypal.com',
    clientId: process.env.PAYPAL_SANDBOX_CLIENT_ID || '',
    clientSecret: process.env.PAYPAL_SANDBOX_CLIENT_SECRET || '',
    plans: {
      monthly: process.env.PAYPAL_SANDBOX_PLAN_MONTHLY || '',
      promo:   process.env.PAYPAL_SANDBOX_PLAN_PROMO   || '',
      annual:  process.env.PAYPAL_SANDBOX_PLAN_ANNUAL  || ''
    }
  }
};
const CFG = CONFIGS[(process.env.PAYPAL_ENV || 'live').toLowerCase()] || CONFIGS.live;

let _tok = { value: '', exp: 0 };
async function paypalToken() {
  const now = Date.now();
  if (_tok.value && now < _tok.exp) return _tok.value;
  const basic = Buffer.from(`${CFG.clientId}:${CFG.clientSecret}`).toString('base64');
  const r = await fetch(`${CFG.base}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: 'grant_type=client_credentials'
  });
  if (!r.ok) throw new Error('PAYPAL_TOKEN_' + r.status);
  const j = await r.json();
  _tok = { value: j.access_token, exp: now + (Number(j.expires_in) || 28800 - 200) * 1000 };
  return _tok.value;
}

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }
    });
    const j = await r.json();
    if (j && typeof j.result === 'string' && j.result) {
      try { return JSON.parse(j.result); } catch (e) { return null; }
    }
    return null;
  } catch (e) { return null; }
}

function originOf(req) {
  try { if (req.headers.origin) return new URL(req.headers.origin).origin; } catch (e) {}
  try { if (req.headers.referer) return new URL(req.headers.referer).origin; } catch (e) {}
  return '';
}
function applyCors(req, res) {
  const o = req.headers.origin;
  if (o && ALLOWED_ORIGINS.includes(o)) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
  }
}

// ACTIVE / APPROVED（已批准待激活）即有效；CANCELLED 在已付周期结束前仍有效；其余无效
function entitled(status, nextBillingTime) {
  if (status === 'ACTIVE' || status === 'APPROVED') return true;
  if (status === 'CANCELLED' && nextBillingTime) {
    try { return Date.now() < new Date(nextBillingTime).getTime(); } catch (e) { return false; }
  }
  return false; // APPROVAL_PENDING / SUSPENDED / EXPIRED
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET,POST,OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const org = originOf(req);
  if (!org || !ALLOWED_ORIGINS.includes(org)) {
    return res.status(403).json({ code: 'ORIGIN_DENIED', error: 'Forbidden' });
  }

  let sid = '';
  try {
    const u = new URL(req.url, 'https://hanverse.app');
    sid = (u.searchParams.get('sid') || u.searchParams.get('subscription_id') || '').trim();
  } catch (e) {}

  if (!sid) return res.status(200).json({ pro: false, code: 'NO_SID' });
  if (!CFG.clientSecret) return res.status(200).json({ pro: false, code: 'NOT_CONFIGURED' });

  try {
    const token = await paypalToken();
    const r = await fetch(`${CFG.base}/v1/billing/subscriptions/${encodeURIComponent(sid)}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    if (!r.ok) return res.status(200).json({ pro: false, code: 'SUB_NOT_FOUND', http: r.status });
    const sub = await r.json();

    // 只能是我们自己的 $4.99 计划
    if (sub.plan_id !== CFG.planId) return res.status(200).json({ pro: false, code: 'PLAN_MISMATCH' });

    // KV 强吊销：退款 / 拒付 / 过期（即使 PayPal 状态仍显示 ACTIVE 也以我们的标记为准）
    const cached = await kvGet('pro:sub:' + sid);
    if (cached && (cached.refunded === 1 || cached.status === 'REFUNDED' ||
                   cached.status === 'REVERSED' || cached.status === 'EXPIRED')) {
      return res.status(200).json({ pro: false, code: 'REMOTE_REVOKED', status: sub.status || '' });
    }

    const status = sub.status || '';
    const next = (sub.billing_info && sub.billing_info.next_billing_time) || '';
    const pro = entitled(status, next);
    return res.status(200).json({ pro, status, code: pro ? 'OK' : 'NOT_ACTIVE' });
  } catch (e) {
    // 上游异常不吊销（避免误伤付费用户）；前端会保持现状、下次再查
    return res.status(200).json({ pro: false, code: 'UPSTREAM_ERROR', detail: String((e && e.message) || '').slice(0, 120) });
  }
}
