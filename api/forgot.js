// HanVerse accounts —— 忘记密码（发重置链接；不泄露账号是否存在）
import { randomBytes } from 'node:crypto';
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
async function kvSetEx(key, obj, ex) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    const value = encodeURIComponent(JSON.stringify(obj));
    const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}/${value}?ex=${ex}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    return r.ok;
  } catch (e) { return false; }
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
async function sendEmail(to, subject, html) {
  const key = process.env.RESEND_API_KEY || '';
  if (!key) return { sent: false, reason: 'EMAIL_NOT_CONFIGURED' };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'HanVerse <noreply@hanverse.app>', to, subject, html })
    });
    return { sent: r.ok };
  } catch (e) { return { sent: false }; }
}
export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ code: 'BAD_METHOD' })); }
  let body = {};
  try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) {}
  const email = String(body.email || '').trim().toLowerCase();
  const rec = await kvGet('acct:' + email);
  let mailSent = false;
  if (rec && rec.hash) {
    const token = randomBytes(24).toString('hex');
    await kvSetEx('pwreset:' + email, { token, exp: Math.floor(Date.now() / 1000) + 3600 }, 3700);
    const link = `https://www.hanverse.app/#/reset?email=${encodeURIComponent(email)}&t=${token}`;
    const mail = await sendEmail(email, 'Reset your HanVerse password',
      `Reset your password using this link (valid 1 hour):<br><a href="${link}">${link}</a>`);
    mailSent = mail.sent;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ code: 'OK', ok: true, emailSent: mailSent }));
}
