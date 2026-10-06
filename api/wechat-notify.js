// HanVerse —— 微信支付回调（APIv3 验签 + AES-GCM 解密 + 幂等开通权益）
// POST /api/wechat-notify （微信服务器直接调用，无浏览器 Origin，只认真签名）
import { createPublicKey, verify, createDecipheriv } from 'node:crypto';
const KV_URL = process.env.KV_REST_API_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || '';
const API_V3_KEY = process.env.WECHAT_API_V3_KEY || '';
const PLATFORM_PUB = (process.env.WECHAT_PLATFORM_PUBLIC_KEY || '').replace(/\\n/g, '\n');

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
function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const SKU_DAYS = { M30: 30, Y365: 365 };

/* 推荐奖励：被推荐人微信支付成功购买年卡(Y365) → 推荐人账号 +30 天 bonus（幂等防刷） */
const REFERRAL_BONUS_DAYS = 30;
async function grantReferralBonus(refEmail, buyerEmail, now) {
  if (!refEmail || !buyerEmail) return null;
  refEmail = String(refEmail).trim().toLowerCase();
  if (refEmail === buyerEmail) return null;
  const bonusKey = 'bonus:' + refEmail + ':' + buyerEmail;
  if (await kvGet(bonusKey)) return null;
  const refAcct = await kvGet('acct:' + refEmail);
  if (!refAcct || !refAcct.hash) return null;
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

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ code: 'Method not allowed' });

  const body = await readRaw(req);
  const ts = String(req.headers['wechatpay-timestamp'] || '');
  const nonce = String(req.headers['wechatpay-nonce'] || '');
  const sig = String(req.headers['wechatpay-signature'] || '');

  // 1) 验签（需要平台公钥）
  if (!PLATFORM_PUB) return res.status(500).json({ code: 'FAIL', message: 'platform key missing' });
  try {
    const pub = createPublicKey(PLATFORM_PUB);
    const ok = verify('sha256', Buffer.from(`${ts}\n${nonce}\n${body}\n`), pub, Buffer.from(sig, 'base64'));
    if (!ok) return res.status(400).json({ code: 'FAIL', message: 'invalid signature' });
  } catch (e) {
    return res.status(400).json({ code: 'FAIL', message: 'verify error' });
  }

  // 2) 解密 resource
  let event;
  try { event = JSON.parse(body); } catch (e) { return res.status(400).json({ code: 'FAIL' }); }
  const r = event.resource || {};
  if (!API_V3_KEY || !r.ciphertext) return res.status(500).json({ code: 'FAIL', message: 'decrypt key missing' });
  let plain;
  try {
    const d = createDecipheriv('aes-256-gcm', Buffer.from(API_V3_KEY, 'utf8'), Buffer.from(r.nonce, 'utf8'));
    d.setAuthTag(Buffer.from(r.ciphertext.slice(-24), 'base64'));
    d.setAAD(Buffer.from(r.associated_data || '', 'utf8'));
    plain = JSON.parse(Buffer.concat([d.update(Buffer.from(r.ciphertext.slice(0, -24), 'base64')), d.final()]).toString('utf8'));
  } catch (e) {
    return res.status(400).json({ code: 'FAIL', message: 'decrypt error' });
  }

  // 3) 幂等开通
  const outTradeNo = plain.out_trade_no || '';
  const order = await kvGet('order:' + outTradeNo);
  if (!order) return res.status(404).json({ code: 'FAIL', message: 'unknown order' });
  if (order.status === 'PAID') return res.status(200).json({ code: 'SUCCESS' });
  if (plain.trade_state !== 'SUCCESS') return res.status(200).json({ code: 'SUCCESS' }); // 非成功态不处理

  const days = SKU_DAYS[order.sku] || 30;
  const exp = Math.floor(Date.now() / 1000) + days * 86400;
  order.status = 'PAID';
  order.paidAt = Math.floor(Date.now() / 1000);
  order.transactionId = plain.transaction_id || '';
  await kvSet('order:' + outTradeNo, order);

  const acct = await kvGet('acct:' + order.email);
  if (acct) {
    acct.wx = { orderId: outTradeNo, sku: order.sku, days, exp, at: order.paidAt };
    await kvSet('acct:' + order.email, acct);
    // 推荐奖励：仅年卡 Y365；ref 取被推荐人注册时存的归因
    if (order.sku === 'Y365' && acct.ref) {
      await grantReferralBonus(acct.ref, order.email, Math.floor(Date.now() / 1000));
    }
  }
  // 许可证邮件（Resend；未配置则静默不影响回调）
  try {
    const key = process.env.RESEND_API_KEY || '';
    if (key) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'HanVerse <noreply@hanverse.app>',
          to: order.email,
          subject: 'Your HanVerse Pro license',
          html: `Thank you for your payment!<br><br>Plan: <strong>${order.sku === 'Y365' ? 'Pro Yearly' : 'Pro Monthly'}</strong><br>Valid until: ${new Date(exp * 1000).toISOString().slice(0, 10)}<br><br>Manage your subscription at <a href="https://www.hanverse.app/#/account">hanverse.app</a>.`
        })
      });
    }
  } catch (e) {}
  return res.status(200).json({ code: 'SUCCESS' });
}
