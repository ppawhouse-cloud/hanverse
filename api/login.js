// HanVerse accounts —— 登录（scrypt 校验，签发会话 token）
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

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
async function kvSet(key, obj, exSeconds) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    const value = encodeURIComponent(JSON.stringify(obj));
    const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}/${value}${exSeconds ? `?ex=${exSeconds}` : ''}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
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
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function send(res, code, extra, http = 200) {
  res.statusCode = http;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(Object.assign({ code }, extra || {})));
}
function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return send(res, 'BAD_METHOD', {}, 405);
  const org = originOf(req);
  if (!org || !ALLOWED_ORIGINS.includes(org)) return send(res, 'ORIGIN_DENIED', {}, 403);

  let body = {};
  try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { return send(res, 'BAD_REQUEST'); }
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  const rec = await kvGet('acct:' + email);
  if (!rec || !rec.hash) return send(res, 'INVALID_CREDENTIALS', { error: 'Email or password is incorrect.' }, 401);
  const candidate = scryptSync(password, rec.salt, 64);
  const stored = Buffer.from(rec.hash, 'hex');
  if (candidate.length !== stored.length || !timingSafeEqual(candidate, stored)) {
    return send(res, 'INVALID_CREDENTIALS', { error: 'Email or password is incorrect.' }, 401);
  }
  const token = b64url(randomBytes(32));
  await kvSet('sess:' + token, { email, exp: Math.floor(Date.now() / 1000) + 30 * 86400 }, 31 * 86400);
  return send(res, 'OK', { ok: true, token, email, verified: !!rec.verified });
}
