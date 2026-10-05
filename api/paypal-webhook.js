// HanVerse Pro —— PayPal 订阅 Webhook（Vercel Node Serverless Function）
//
// PayPal 服务器在订阅开通 / 续费 / 暂停 / 取消 / 过期 / 退款 / 拒付时回调本函数。
// 流程：读取原始 body → 调用 PayPal verify-webhook-signature 验签（防伪造）
//      → 把订阅状态写入 Vercel KV（Upstash REST）；退款 / 拒付 / 过期置强吊销标记。
// check-pro.js 读取这些标记并实时回查 PayPal，从而实现“付款即解锁、退款即收回”。
//
// Webhook 来自 PayPal 服务器（无浏览器 Origin），不做来源校验，只认真假签名。
// 机密：仅 PAYPAL_LIVE_CLIENT_SECRET 走环境变量；webhook_id / client_id 半公开，内置默认。

const KV_URL = process.env.KV_REST_API_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || '';

const CONFIGS = {
  live: {
    base: 'https://api-m.paypal.com',
    clientId: process.env.PAYPAL_LIVE_CLIENT_ID || 'BAA4i2iDg_ZtXgYXz8l10jUOKgBGJH8Q1iuo8DR12mElRqE8sRw5-avTFYEC8KriL-FfQedT6eoTidapCQ',
    clientSecret: process.env.PAYPAL_LIVE_CLIENT_SECRET || '',
    webhookId: process.env.PAYPAL_LIVE_WEBHOOK_ID || '5ME74510UT666034S',
  },
  sandbox: {
    base: 'https://api-m.sandbox.paypal.com',
    clientId: process.env.PAYPAL_SANDBOX_CLIENT_ID || '',
    clientSecret: process.env.PAYPAL_SANDBOX_CLIENT_SECRET || '',
    webhookId: process.env.PAYPAL_SANDBOX_WEBHOOK_ID || '',
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
async function kvSet(key, obj) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    const value = encodeURIComponent(JSON.stringify(obj));
    const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}/${value}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }
    });
    return r.ok;
  } catch (e) { console.error('KV set error:', e && e.message); return false; }
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function certHostOk(url) {
  try { const h = new URL(url).hostname; return h === 'paypal.com' || h.endsWith('.paypal.com'); }
  catch (e) { return false; }
}

async function verifySignature(event, headers) {
  const certUrl = headers['paypal-cert-url'];
  if (!certUrl || !certHostOk(certUrl)) return false;
  const token = await paypalToken();
  const r = await fetch(`${CFG.base}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth_algo: headers['paypal-auth-algorithm'],
      cert_url: certUrl,
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: CFG.webhookId,
      webhook_event: event
    })
  });
  if (!r.ok) { console.error('verify http', r.status); return false; }
  const j = await r.json();
  return j.verification_status === 'SUCCESS';
}

const SUB_ON = ['BILLING.SUBSCRIPTION.ACTIVATED', 'BILLING.SUBSCRIPTION.RENEWED', 'BILLING.SUBSCRIPTION.RE-ACTIVATED'];
async function applyEvent(type, r) {
  const now = Date.now();
  let sid = '';
  let patch = null;

  if (type && type.indexOf('PAYMENT.SALE.') === 0) {
    sid = r.billing_agreement_id || '';
    if (type === 'PAYMENT.SALE.COMPLETED') {
      const ex = (await kvGet('pro:sub:' + sid)) || {};
      // 已有记录：只补付款时间，不覆盖退款/状态（防止迟到事件重新打开已退款订阅）
      if (ex && ex.status) {
        ex.last_payment_time = r.create_time || ex.last_payment_time || '';
        await kvSet('pro:sub:' + sid, ex);
        return { sid, stored: true, status: ex.status };
      }
      patch = { status: 'ACTIVE', refunded: 0, last_payment_time: r.create_time || '', ts: now };
    } else if (type === 'PAYMENT.SALE.REFUNDED') {
      patch = { status: 'REFUNDED', refunded: 1, refund_time: r.create_time || '', ts: now };
    } else if (type === 'PAYMENT.SALE.REVERSED') {
      patch = { status: 'REVERSED', refunded: 1, refund_time: r.create_time || '', ts: now };
    } else {
      return { ignored: true, type };
    }
  } else if (SUB_ON.indexOf(type) !== -1) {
    sid = r.id || '';
    patch = {
      status: r.status || 'ACTIVE', refunded: 0, plan_id: r.plan_id || '',
      next_billing_time: (r.billing_info && r.billing_info.next_billing_time) || '', ts: now
    };
  } else if (type === 'BILLING.SUBSCRIPTION.SUSPENDED') {
    sid = r.id || '';
    patch = { status: 'SUSPENDED', ts: now };
  } else if (type === 'BILLING.SUBSCRIPTION.CANCELLED') {
    sid = r.id || '';
    patch = { status: 'CANCELLED', next_billing_time: (r.billing_info && r.billing_info.next_billing_time) || '', ts: now };
  } else if (type === 'BILLING.SUBSCRIPTION.EXPIRED') {
    sid = r.id || '';
    patch = { status: 'EXPIRED', ts: now };
  } else {
    return { ignored: true, type };
  }

  if (!sid) return { ignored: true, reason: 'no subscription id' };
  const ex = (await kvGet('pro:sub:' + sid)) || {};
  const merged = Object.assign({}, ex, patch);
  await kvSet('pro:sub:' + sid, merged);
  return { sid, status: merged.status, refunded: merged.refunded || 0 };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST,OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  let event;
  try {
    const raw = await readRaw(req);
    event = JSON.parse(raw);
  } catch (e) {
    return res.status(400).json({ error: 'invalid body' });
  }

  try {
    const ok = await verifySignature(event, req.headers);
    if (!ok) return res.status(400).json({ error: 'invalid signature' });

    const type = event.event_type || '';
    const out = await applyEvent(type, event.resource || {});
    return res.status(200).json({ received: true, type, ...out });
  } catch (e) {
    console.error('webhook handler error:', e && e.message);
    // 返回 500 让 PayPal 按策略重试
    return res.status(500).json({ error: 'server error' });
  }
}
