// HanVerse Pro —— 微信小店卡密兑换（Vercel Node Serverless Function）
//
// 买家在微信小店下单、阿奇索自动发货收到唯一码（HV-XXXX-XXXX-XXXX），回到 #/subscribe 输入：
//   本地校验位预检（挡掉手误/枚举）→ sha256 查 KV（rc:<hash>）
//   → 首次激活写入状态 / 已激活幂等返回 / 年卡到期失效 / 单码可吊销。
// 码库由 _scripts/gen_codes.py 生成、import_codes_kv.py 导入（KV 中只存哈希，不存明文）。
// 公开兜底促销码 HANVERSE49 由前端直接识别，不经过本函数。

import { createHash } from 'node:crypto';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://www.hanverse.app,https://hanverse.app')
  .split(',').map(s => s.trim()).filter(Boolean);
const KV_URL = process.env.KV_REST_API_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || '';
const ALPH = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // 必须与 gen_codes.py 完全一致（31 字符）
const REDEEM_PER_MIN = Number(process.env.REDEEM_PER_MIN || 20);  // 每 IP 每分钟最多尝试次数

function originOf(req) {
  try { if (req.headers.origin) return new URL(req.headers.origin).origin; } catch (e) {}
  try { if (req.headers.referer) return new URL(req.headers.referer).origin; } catch (e) {}
  return '';
}
function applyCors(req, res) {
  const o = req.headers.origin;
  if (o && ALLOWED_ORIGINS.includes(o)) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
  }
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
async function kvIncr(key) {
  if (!KV_URL || !KV_TOKEN) return 0;
  try {
    const r = await fetch(`${KV_URL}/incr/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }
    });
    const j = await r.json();
    return Number(j.result) || 0;
  } catch (e) { return 0; }
}
async function kvExpire(key, seconds) {
  if (!KV_URL || !KV_TOKEN) return;
  try {
    await fetch(`${KV_URL}/expire/${encodeURIComponent(key)}/${seconds}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }
    });
  } catch (e) {}
}

function canon(code) {
  return String(code || '').toUpperCase().replace(/[\s-]/g, '');
}
function checkChar(body13) {
  let acc = 0;
  for (const ch of body13) acc = (acc * 31 + ALPH.indexOf(ch)) % 31;
  return ALPH[acc];
}
function validFormat(s) {
  if (s.length !== 14 || s.slice(0, 2) !== 'HV') return false;
  for (const ch of s) if (ALPH.indexOf(ch) < 0) return false;
  return checkChar(s.slice(0, 13)) === s[13];
}
function sha256hex(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return req.headers['x-real-ip'] || (req.socket && req.socket.remoteAddress) || 'unknown';
}
function minuteStamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}
function readRaw(req) {
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

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST,OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const org = originOf(req);
  if (!org || !ALLOWED_ORIGINS.includes(org)) {
    return res.status(403).json({ code: 'ORIGIN_DENIED', error: 'Forbidden' });
  }
  if (!KV_URL || !KV_TOKEN) return send(res, 'KV_UNAVAILABLE', { pro: false });

  let code = '';
  try {
    const raw = await readRaw(req);
    const body = raw ? JSON.parse(raw) : {};
    code = (body.code || '').trim();
  } catch (e) {
    return send(res, 'BAD_REQUEST', { pro: false });
  }
  if (!code) return send(res, 'NO_CODE', { pro: false });

  // IP 限流（按分钟），挡枚举/爆破
  const rk = 'ratelimit:redeem:' + clientIp(req) + ':' + minuteStamp();
  const n = await kvIncr(rk);
  if (n === 1) await kvExpire(rk, 70);
  if (n > REDEEM_PER_MIN) return send(res, 'RATE_LIMITED', { pro: false }, 429);

  const c = canon(code);
  if (!validFormat(c)) return send(res, 'INVALID_CODE', { pro: false });

  const rec = await kvGet('rc:' + sha256hex(c));
  if (!rec) return send(res, 'INVALID_CODE', { pro: false });
  if (rec.r === 1) return send(res, 'REVOKED', { pro: false });

  const now = Math.floor(Date.now() / 1000);
  if (rec.s !== 1) {
    // 首次激活：按码记录中的天数计算到期（d=0 或缺省 = 永久）
    const days = Number(rec.d || 0);
    const exp = days > 0 ? now + days * 86400 : 0;
    await kvSet('rc:' + sha256hex(c), { s: 1, d: days, a: now, e: exp, sku: rec.sku || '' });
    return send(res, 'OK', { pro: true, first: true, days, expiresAt: exp || null });
  }

  // 已激活：幂等返回当前权益（允许买家换设备/清缓存后用同一码重新激活，直到到期/吊销）
  const exp = Number(rec.e || 0);
  if (exp && now > exp) return send(res, 'EXPIRED', { pro: false, expiresAt: exp });
  return send(res, 'OK', { pro: true, first: false, days: Number(rec.d || 0),
    expiresAt: exp || null, activatedAt: rec.a || null });
}
