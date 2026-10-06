// HanVerse —— 微信 Native 支付合并端点（create-order + order-status，节省函数数）
// POST /api/wechat-pay  {action:'create', sku}            → {code_url, outTradeNo}
// GET  /api/wechat-pay?action=status&out_trade_no=...     → {status, sku}
import { createSign, randomBytes } from 'node:crypto';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://www.hanverse.app,https://hanverse.app').split(',').map(s => s.trim()).filter(Boolean);
const KV_URL = process.env.KV_REST_API_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || '';
const MCH_ID = process.env.WECHAT_MCH_ID || '';
const APPID = process.env.WECHAT_APPID || '';
const SERIAL = process.env.WECHAT_CERT_SERIAL_NO || '';
const PRIVATE_KEY = (process.env.WECHAT_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const SKU_FEN = { M30: 3900, Y365: 39900 };
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
async function bearerEmail(req) {
  const h = String(req.headers.authorization || '');
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const sess = await kvGet('sess:' + m[1].trim());
  if (!sess || !sess.email) return null;
  return sess.email;
}
export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  let action = '';
  try { action = new URL(req.url, 'https://x').searchParams.get('action') || ''; } catch (e) {}

  // GET ?action=status
  if (req.method === 'GET') {
    const email = await bearerEmail(req);
    if (!email) return send(res, 'UNAUTHORIZED', {}, 401);
    let otn = '';
    try { otn = new URL(req.url, 'https://x').searchParams.get('out_trade_no') || ''; } catch (e) {}
    const order = await kvGet('order:' + otn);
    if (!order || order.email !== email) return send(res, 'NOT_FOUND', {}, 404);
    return send(res, 'OK', { status: order.status, sku: order.sku });
  }

  // POST {action:'create', sku}
  if (req.method !== 'POST') return send(res, 'BAD_METHOD', {}, 405);
  const email = await bearerEmail(req);
  if (!email) return send(res, 'UNAUTHORIZED', { error: 'Please log in first.' }, 401);
  if (!MCH_ID || !PRIVATE_KEY || !SERIAL) return send(res, 'PAY_NOT_CONFIGURED', { error: 'WeChat Pay is being configured.' }, 503);
  let body = {};
  try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { return send(res, 'BAD_REQUEST'); }
  action = String(body.action || 'create');
  if (action !== 'create') return send(res, 'BAD_REQUEST');
  const sku = body.sku === 'Y365' ? 'Y365' : 'M30';
  const total = SKU_FEN[sku];
  const outTradeNo = 'hv' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const payload = {
    appid: APPID, mchid: MCH_ID, description: `HanVerse Pro ${sku === 'Y365' ? 'Yearly' : 'Monthly'}`,
    out_trade_no: outTradeNo, notify_url: 'https://www.hanverse.app/api/wechat-notify',
    amount: { total, currency: 'CNY' }
  };
  try {
    const ts = Math.floor(Date.now() / 1000).toString();
    const nonce = randomBytes(16).toString('hex');
    const bodyStr = JSON.stringify(payload);
    const signStr = `POST\n/v3/pay/transactions/native\n${ts}\n${nonce}\n${bodyStr}\n`;
    const sig = createSign('RSA-SHA256').update(signStr).sign(PRIVATE_KEY, 'base64');
    const r = await fetch('https://api.mch.weixin.qq.com/v3/pay/transactions/native', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Accept: 'application/json',
        Authorization: `WECHATPAY2-SHA256-RSA2048 mchid="${MCH_ID}",nonce_str="${nonce}",timestamp="${ts}",serial_no="${SERIAL}",signature="${sig}"`
      },
      body: bodyStr,
      signal: AbortSignal.timeout(8000)
    });
    const raw = await r.text();
    let j = {};
    try { j = raw ? JSON.parse(raw) : {}; } catch (e) { j = { rawBody: String(raw).slice(0, 200) }; }
    if (!r.ok || !j.code_url) return send(res, 'PAY_CREATE_FAILED', { http: r.status, detail: j }, 502);
    await kvSet('order:' + outTradeNo, { email, sku, total, status: 'CREATED', createdAt: Math.floor(Date.now() / 1000), outTradeNo });
    return send(res, 'OK', { code_url: j.code_url, outTradeNo, sku, total });
  } catch (e) {
    return send(res, 'ERROR', { detail: String(e.message || '').slice(0, 120) }, 502);
  }
}

