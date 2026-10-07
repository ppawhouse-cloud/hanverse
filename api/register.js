// HanVerse accounts —— 注册（邮箱+密码，scrypt 加盐哈希，签名会话 token）
// 前端 POST /api/register {email, password, ref?} → {ok, token, email, verified}
// 会话：sess:<token> 存 KV（含过期时间），登出即删。
import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';

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
function hashPassword(pw, salt) {
  return scryptSync(String(pw), salt, 64).toString('hex');
}
function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

/* 事务邮件（Resend，未配置时仅记录不抛错）——与 api/send-email.js 同约定 */
async function sendEmail(to, subject, html) {
  const key = process.env.RESEND_API_KEY || '';
  if (!key) return { sent: false, reason: 'EMAIL_NOT_CONFIGURED' };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'HanVerse <noreply@hanverse.app>', to, subject, html })
    });
    return { sent: r.ok, reason: r.ok ? '' : ('HTTP_' + r.status) };
  } catch (e) { return { sent: false, reason: 'NETWORK' }; }
}
function makeVerifyToken(email) {
  const exp = Math.floor(Date.now() / 1000) + 7 * 86400;
  const payload = `${email}|${exp}`;
  const sig = createHmac('sha256', AUTH_SECRET).update(payload).digest();
  return b64url(payload) + '.' + b64url(sig);
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return send(res, 'BAD_METHOD', { error: 'POST only' }, 405);
  const org = originOf(req);
  if (!org || !ALLOWED_ORIGINS.includes(org)) return send(res, 'ORIGIN_DENIED', { error: 'Forbidden' }, 403);
  if (!KV_URL || !KV_TOKEN) return send(res, 'KV_UNAVAILABLE', { error: 'Service unavailable' }, 503);
  if (!AUTH_SECRET) return send(res, 'AUTH_NOT_CONFIGURED', { error: 'Auth service not configured' }, 503);

  let body = {};
  try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { return send(res, 'BAD_REQUEST'); }
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return send(res, 'INVALID_EMAIL', { error: 'Please enter a valid email address.' });
  if (password.length < 8) return send(res, 'WEAK_PASSWORD', { error: 'Password must be at least 8 characters.' });

  const key = 'acct:' + email;
  const ex = await kvGet(key);
  if (ex && ex.hash) return send(res, 'EMAIL_TAKEN', { error: 'This email is already registered. Try logging in.' }, 409);

  const salt = randomBytes(16).toString('hex');
  const rec = {
    email, salt, hash: hashPassword(password, salt),
    verified: false, createdAt: Math.floor(Date.now() / 1000),
    ref: String(body.ref || '').slice(0, 64),
    // 新注册赠送 7 天 Pro 免费试用（无需信用卡）；到期由 me.js computeEntitlement 自动判失效、回落免费档
    trial: { exp: Math.floor(Date.now() / 1000) + 7 * 86400 }
  };
  await kvSet(key, rec);

  // 会话 token
  const token = b64url(randomBytes(32));
  const exp = Math.floor(Date.now() / 1000) + 30 * 86400;
  await kvSet('sess:' + token, { email, exp }, 31 * 86400);

  // 验证邮件（best effort；未配邮件服务时前端仍提示可稍后验证）
  const vt = makeVerifyToken(email);
  const vlink = `https://www.hanverse.app/#/verify-email?t=${vt}`;
  const mail = await sendEmail(email, 'Verify your HanVerse email',
    `Welcome to HanVerse!<br><br>Confirm your email to finish setup: <a href="${vlink}">${vlink}</a><br><br>Link expires in 7 days.`);

  return send(res, 'OK', { ok: true, token, email, verified: false, emailSent: mail.sent });
}
