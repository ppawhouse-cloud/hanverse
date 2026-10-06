// HanVerse —— 微信订单状态轮询（前端扫码后轮询）
// GET /api/wechat-order-status?out_trade_no=...  Authorization: Bearer <token>
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://www.hanverse.app,https://hanverse.app').split(',').map(s => s.trim()).filter(Boolean);
const KV_URL = process.env.KV_REST_API_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || '';
async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    const j = await r.json();
    if (j && typeof j.result === 'string' && j.result) { try { return JSON.parse(j.result); } catch (e) { return null; } }
    return null;
  } catch (e) { return null; }
}
function originOf(req) { try { if (req.headers.origin) return new URL(req.headers.origin).origin; } catch (e) {} return ''; }
function applyCors(req, res) {
  const o = req.headers.origin;
  if (o && ALLOWED_ORIGINS.includes(o)) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Vary', 'Origin');
  }
}
export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  res.setHeader('Content-Type', 'application/json');
  const h = String(req.headers.authorization || '');
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ code: 'UNAUTHORIZED' });
  const sess = await kvGet('sess:' + m[1].trim());
  if (!sess || !sess.email) return res.status(401).json({ code: 'UNAUTHORIZED' });
  let otn = '';
  try { otn = new URL(req.url, 'https://x').searchParams.get('out_trade_no') || ''; } catch (e) {}
  const order = await kvGet('order:' + otn);
  if (!order || order.email !== sess.email) return res.status(404).json({ code: 'NOT_FOUND' });
  return res.status(200).json({ code: 'OK', status: order.status, sku: order.sku });
}
