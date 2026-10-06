// HanVerse accounts —— 重置密码（校验 KV 一次性 token，scrypt 重算哈希）
import { scryptSync, randomBytes } from 'node:crypto';
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
async function kvSet(key, obj) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    const value = encodeURIComponent(JSON.stringify(obj));
    const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    return r.ok;
  } catch (e) { return false; }
}
async function kvDel(key) {
  if (!KV_URL || !KV_TOKEN) return;
  try { await fetch(`${KV_URL}/del/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } }); } catch (e) {}
}
function originOf(req) { try { if (req.headers.origin) return new URL(req.headers.origin).origin; } catch (e) {} return ''; }
function applyCors(req, res) {
  const o = req.headers.origin;
  if (o && ALLOWED_ORIGINS.includes(o)) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
  let body = {};
  try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { return send(res, 'BAD_REQUEST'); }
  const email = String(body.email || '').trim().toLowerCase();
  const token = String(body.token || '').trim();
  const password = String(body.password || '');
  if (password.length < 8) return send(res, 'WEAK_PASSWORD', { error: 'Password must be at least 8 characters.' });
  const pr = await kvGet('pwreset:' + email);
  if (!pr || pr.token !== token || (pr.exp && Math.floor(Date.now() / 1000) > pr.exp)) {
    return send(res, 'INVALID_TOKEN', { error: 'Reset link is invalid or expired. Request a new one.' }, 400);
  }
  const rec = await kvGet('acct:' + email);
  if (!rec) return send(res, 'NOT_FOUND', {}, 404);
  rec.salt = randomBytes(16).toString('hex');
  rec.hash = scryptSync(password, rec.salt, 64).toString('hex');
  await kvSet('acct:' + email, rec);
  await kvDel('pwreset:' + email);
  return send(res, 'OK', { ok: true });
}
