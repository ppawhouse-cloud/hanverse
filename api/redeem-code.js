// HanVerse Pro —— 兑换码（双路径）
// 路径 A（兼容旧码）：本地校验位预检 → sha256 查 KV（rc:<hash>），旧随机卡密。
// 路径 B（新 HMAC 签名码）：HV-M30-XXXXXXXX-XXXXXX，SKU(M30月卡/Y365年卡)+随机体+HMAC-SHA256 校验段，
//      CODE_SIGNING_SECRET 验真无需 KV；首次激活才写 KV（绑定账号/时间/到期/吊销/归因），同账号跨设备幂等。
import { createHash, createHmac } from 'node:crypto';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://www.hanverse.app,https://hanverse.app').split(',').map(s => s.trim()).filter(Boolean);
const KV_URL = process.env.KV_REST_API_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || '';
const CODE_SIGNING_SECRET = process.env.CODE_SIGNING_SECRET || '';
const ALPH = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // 与 gen_codes_hmac.py 一致（31 字符，去易混）
const REDEEM_PER_MIN = Number(process.env.REDEEM_PER_MIN || 30);

function originOf(req) {
  try { if (req.headers.origin) return new URL(req.headers.origin).origin; } catch (e) {}
  return '';
}
function applyCors(req, res) {
  const o = req.headers.origin;
  if (o && ALLOWED_ORIGINS.includes(o)) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Vary', 'Origin');
  }
}
async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
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
    const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}/${value}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    return r.ok;
  } catch (e) { console.error('KV set error:', e && e.message); return false; }
}
async function kvIncr(key) {
  if (!KV_URL || !KV_TOKEN) return 0;
  try {
    const r = await fetch(`${KV_URL}/incr/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    const j = await r.json();
    return Number(j.result) || 0;
  } catch (e) { return 0; }
}
async function kvExpire(key, seconds) {
  if (!KV_URL || !KV_TOKEN) return;
  try { await fetch(`${KV_URL}/expire/${encodeURIComponent(key)}/${seconds}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } }); } catch (e) {}
}
function canon(code) { return String(code || '').toUpperCase().replace(/[\s-]/g, ''); }
function checkCharOld(body13) {
  let acc = 0;
  for (const ch of body13) acc = (acc * 31 + ALPH.indexOf(ch)) % 31;
  return ALPH[acc];
}
function validOldFormat(s) {
  if (s.length !== 14 || s.slice(0, 2) !== 'HV') return false;
  for (const ch of s) if (ALPH.indexOf(ch) < 0) return false;
  return checkCharOld(s.slice(0, 13)) === s[13];
}
function sha256hex(s) { return createHash('sha256').update(s, 'utf8').digest('hex'); }
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return req.headers['x-real-ip'] || 'unknown';
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

/* 推荐奖励：被推荐人成功激活年卡(Y365) → 推荐人账号 +30 天 bonus（幂等防刷） */
const REFERRAL_BONUS_DAYS = 30;
async function grantReferralBonus(refEmail, buyerEmail, now) {
  if (!refEmail || !buyerEmail) return null;
  refEmail = String(refEmail).trim().toLowerCase();
  if (refEmail === buyerEmail) return null;               // 不能自己推荐自己
  const bonusKey = 'bonus:' + refEmail + ':' + buyerEmail;
  if (await kvGet(bonusKey)) return null;                 // 同一对被推荐人只奖励一次
  const refAcct = await kvGet('acct:' + refEmail);
  if (!refAcct || !refAcct.hash) return null;             // 推荐人必须已是注册账号
  // 在推荐人当前最长权益基础上 +30 天；无权益则从当前时刻起 +30 天
  let base = now;
  for (const k of ['code', 'wx']) {
    const e = Number(refAcct[k] && refAcct[k].exp) || 0;
    if (e > base) base = e;
  }
  const bExp = base + REFERRAL_BONUS_DAYS * 86400;
  refAcct.bonus = { days: REFERRAL_BONUS_DAYS, exp: bExp, from: buyerEmail, at: now };
  await kvSet('acct:' + refEmail, refAcct);
  await kvSet(bonusKey, { at: now, buyer: buyerEmail });
  return { ref: refEmail, exp: bExp };
}

/* ---- 新 HMAC 码：HV-M30-XXXXXXXX-XXXXXX ---- */
const SKU_DAYS = { M30: 30, Y365: 365 };
function parseHmacCode(raw) {
  // raw 已去连字符大写化；M30=HVM30+8+6=19 位，Y365=HVY365+8+6=20 位
  let sku = '', body = '', sig = '';
  if (raw.startsWith('HVM30') && raw.length === 19) {
    sku = 'M30'; body = raw.slice(5, 13); sig = raw.slice(13, 19);
  } else if (raw.startsWith('HVY365') && raw.length === 20) {
    sku = 'Y365'; body = raw.slice(6, 14); sig = raw.slice(14, 20);
  } else return null;
  for (const ch of body + sig) if (ALPH.indexOf(ch) < 0) return null;
  return { sku, body, sig, signed: `HV-${sku}-${body}` };
}
function verifyHmac(parsed) {
  if (!CODE_SIGNING_SECRET) return false;
  const h = createHmac('sha256', CODE_SIGNING_SECRET).update(parsed.signed).digest();
  // 取前 6 字符：按 base31 编码 HMAC 前 4 字节
  let n = h.readUInt32BE(0);
  let out = '';
  for (let i = 0; i < 6; i++) { out += ALPH[n % 31]; n = Math.floor(n / 31); }
  return out === parsed.sig;
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST,OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const org = originOf(req);
  if (!org || !ALLOWED_ORIGINS.includes(org)) return send(res, 'ORIGIN_DENIED', { pro: false }, 403);
  if (!KV_URL || !KV_TOKEN) return send(res, 'KV_UNAVAILABLE', { pro: false });

  let code = '', token = '', ref = '';
  try {
    const body = JSON.parse(await readRaw(req) || '{}');
    code = (body.code || '').trim();
    token = (body.token || '').trim();
    ref = (body.ref || '').trim();
  } catch (e) { return send(res, 'BAD_REQUEST', { pro: false }); }
  if (!code) return send(res, 'NO_CODE', { pro: false });

  // 限流
  const rk = 'ratelimit:redeem:' + clientIp(req) + ':' + minuteStamp();
  const n = await kvIncr(rk);
  if (n === 1) await kvExpire(rk, 70);
  if (n > REDEEM_PER_MIN) return send(res, 'RATE_LIMITED', { pro: false }, 429);

  const c = canon(code);

  /* 路径 A：旧随机码（兼容） */
  if (validOldFormat(c)) {
    const rec = await kvGet('rc:' + sha256hex(c));
    if (!rec) return send(res, 'INVALID_CODE', { pro: false });
    if (rec.r === 1) return send(res, 'REVOKED', { pro: false });
    const now = Math.floor(Date.now() / 1000);
    if (rec.s !== 1) {
      const days = Number(rec.d || 0);
      const exp = days > 0 ? now + days * 86400 : 0;
      await kvSet('rc:' + sha256hex(c), Object.assign({}, rec, { s: 1, a: now, e: exp, ref: rec.ref || ref || '' }));
      return send(res, 'OK', { pro: true, first: true, days, expiresAt: exp || null });
    }
    const exp = Number(rec.e || 0);
    if (exp && now > exp) return send(res, 'EXPIRED', { pro: false, expiresAt: exp });
    return send(res, 'OK', { pro: true, first: false, days: Number(rec.d || 0), expiresAt: exp || null });
  }

  /* 路径 B：HMAC 签名码 */
  const parsed = parseHmacCode(c);
  if (!parsed || !verifyHmac(parsed)) return send(res, 'INVALID_CODE', { pro: false });

  // 必须登录才能把码绑到账号
  let email = '';
  if (token) {
    const sess = await kvGet('sess:' + token);
    if (sess && sess.email) email = sess.email;
  }
  if (!email) return send(res, 'LOGIN_REQUIRED', { pro: false, error: 'Please log in first to activate this code.' }, 401);

  const days = SKU_DAYS[parsed.sku] || 30;
  const storeKey = 'rc:hmac:' + c;
  const rec = await kvGet(storeKey);
  const now = Math.floor(Date.now() / 1000);
  if (rec && rec.a) {
    // 已激活：同账号幂等；他人拒绝
    if (rec.email !== email) return send(res, 'CODE_BOUND_OTHER', { pro: false, error: 'This code has already been activated on another account.' }, 409);
    const exp = Number(rec.e || 0);
    if (exp && now > exp) return send(res, 'EXPIRED', { pro: false, expiresAt: exp });
    return send(res, 'OK', { pro: true, first: false, sku: parsed.sku, days, expiresAt: exp || null });
  }
  // 首次激活：写 KV + 落到账号
  const exp = now + days * 86400;
  await kvSet(storeKey, { sku: parsed.sku, days, a: now, e: exp, email, ref: ref || '' });
  const acct = await kvGet('acct:' + email);
  if (acct) {
    acct.code = { code: c, sku: parsed.sku, days, exp, at: now };
    await kvSet('acct:' + email, acct);
  }
  // 推荐奖励：仅年卡 Y365；ref 优先请求体归因，其次被推荐人注册时存的 ref
  if (parsed.sku === 'Y365') {
    const refRaw = (ref || (acct && acct.ref) || '').trim();
    if (refRaw) await grantReferralBonus(refRaw, email, now);
  }
  return send(res, 'OK', { pro: true, first: true, sku: parsed.sku, days, expiresAt: exp });
}
