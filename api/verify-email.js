// HanVerse accounts —— 邮箱验证（HMAC 签名链接，GET ?t=）
import { createHmac } from 'node:crypto';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://www.hanverse.app,https://hanverse.app').split(',').map(s => s.trim()).filter(Boolean);
const KV_URL = process.env.KV_REST_API_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || '';
const AUTH_SECRET = process.env.AUTH_SECRET || '';
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
function applyCors(req, res) {
  const o = req.headers.origin;
  if (o && ALLOWED_ORIGINS.includes(o)) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Vary', 'Origin');
  }
}
function b64urlD(s) { return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); }
export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  res.setHeader('Content-Type', 'application/json');
  if (!AUTH_SECRET) return res.status(503).end(JSON.stringify({ code: 'AUTH_NOT_CONFIGURED' }));
  let t = '';
  try { t = new URL(req.url, 'https://x').searchParams.get('t') || ''; } catch (e) {}
  const [payload, sig] = t.split('.');
  if (!payload || !sig) return res.status(400).end(JSON.stringify({ code: 'BAD_TOKEN' }));
  const expect = createHmac('sha256', AUTH_SECRET).update(payload).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (expect !== sig) return res.status(400).end(JSON.stringify({ code: 'BAD_TOKEN' }));
  let email = '', exp = 0;
  try { [email, exp] = b64urlD(payload).split('|'); exp = Number(exp); } catch (e) {}
  if (!email || !exp || Math.floor(Date.now() / 1000) > exp) return res.status(400).end(JSON.stringify({ code: 'EXPIRED_TOKEN' }));
  const rec = await kvGet('acct:' + email);
  if (!rec) return res.status(404).end(JSON.stringify({ code: 'NOT_FOUND' }));
  rec.verified = true;
  await kvSet('acct:' + email, rec);
  return res.status(200).end(JSON.stringify({ code: 'OK', ok: true, email }));
}
