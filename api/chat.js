// HanVerse AI Tutor 后端（Vercel Node Serverless Function，固定 hkg1 香港）
//
// 上游 LLM 全部经环境变量配置（OpenAI 兼容 /chat/completions）：
//   ARK_URL                         完整 chat/completions 地址
//   ARK_API_KEY 或 DOUBAO_API_KEY   密钥
//   ARK_MODEL 或 DOUBAO_MODEL       模型名（线上为 MiniMax-M3）
//
// 防盗刷 / 成本封顶：
//   1) 来源校验：仅接受 ALLOWED_ORIGINS（默认 hanverse.app），跨站直连一律 403
//   2) 服务端限流：
//      - 单实例突发兜底：每 IP 每 CHAT_RATE_WINDOW_MS 最多 CHAT_RATE_BURST 次（零配置）
//      - 跨实例每日硬限额：配置 Vercel KV 后，每 IP 每天 CHAT_DAILY_LIMIT_PER_IP 次
//        （Vercel Storage → KV 一键启用即自动注入 KV_REST_API_URL / KV_REST_API_TOKEN）
//   3) Cloudflare Turnstile 人机校验：配置 TURNSTILE_SECRET_KEY 后校验前端 cfToken
//   4) 单次成本封顶：ARK_MAX_TOKENS、ARK_TIMEOUT_MS、CHAT_MAX_MSG_CHARS
//
// 说明：站点经 Cloudflare 代理，502/503/504 响应体会被替换为代理错误页；
//       业务错误统一以 HTTP 200 + code 返回；403/429 为主动拒绝，正常透传。

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label || 'UPSTREAM_TIMEOUT')), ms))
  ]);
}

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://www.hanverse.app,https://hanverse.app')
  .split(',').map(s => s.trim()).filter(Boolean);
const DAILY_LIMIT = parseInt(process.env.CHAT_DAILY_LIMIT_PER_IP || '60', 10);
const RATE_BURST = parseInt(process.env.CHAT_RATE_BURST || '8', 10);
const RATE_WINDOW_MS = parseInt(process.env.CHAT_RATE_WINDOW_MS || String(20 * 1000), 10);
const UPSTREAM_TIMEOUT_MS = parseInt(process.env.ARK_TIMEOUT_MS || '15000', 10);
const MAX_TOKENS = parseInt(process.env.ARK_MAX_TOKENS || '500', 10);
const MAX_MSG_CHARS = parseInt(process.env.CHAT_MAX_MSG_CHARS || '600', 10);

const ARK_URL = process.env.ARK_URL || 'https://ark.ap-southeast.bytepluses.com/api/v3/chat/completions';
const ARK_KEY = process.env.ARK_API_KEY || process.env.DOUBAO_API_KEY || '';
const MODEL = process.env.ARK_MODEL || process.env.DOUBAO_MODEL || 'doubao-pro-32k';
const KV_URL = process.env.KV_REST_API_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || '';
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY || '';

// 单实例内存突发限流（多实例下仅兜底；KV 日限额才是跨实例硬限制）
const burst = new Map();
function burstCheck(ip) {
  const now = Date.now();
  if (burst.size > 5000) {
    for (const [k, v] of burst) if (now - v.t > RATE_WINDOW_MS) burst.delete(k);
  }
  const e = burst.get(ip);
  if (!e || now - e.t > RATE_WINDOW_MS) { burst.set(ip, { t: now, n: 1 }); return true; }
  e.n += 1;
  return e.n <= RATE_BURST;
}

// Vercel KV（底层 Upstash Redis REST）按 IP + UTC 日计数；未配置或故障时放行（可用性优先）
async function kvDailyCount(ip) {
  if (!KV_URL || !KV_TOKEN) return 0;
  try {
    const day = new Date().toISOString().slice(0, 10);
    const key = `ratelimit:chat:${ip}:${day}`;
    const headers = { Authorization: `Bearer ${KV_TOKEN}` };
    const inc = await fetch(`${KV_URL}/incr/${encodeURIComponent(key)}`, { headers });
    const j = await inc.json();
    const count = (j && typeof j.result === 'number') ? j.result : 0;
    if (count === 1) {
      await fetch(`${KV_URL}/expire/${encodeURIComponent(key)}/90000`, { headers });
    }
    return count;
  } catch (e) {
    console.error('KV rate limit error:', e && e.message);
    return 0;
  }
}

async function turnstileOk(token, ip) {
  if (!TURNSTILE_SECRET) return true; // 未配置：不启用
  if (!token) return false;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: TURNSTILE_SECRET, response: token, remoteip: ip })
    });
    const j = await r.json();
    return !!(j && j.success);
  } catch (e) {
    console.error('Turnstile verify error:', e && e.message);
    return false;
  }
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return req.headers['x-real-ip'] || 'unknown';
}

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

function send(res, payload) {
  return res.status(200).json(payload);
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST,OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 1) 来源校验（最早拦截，不消耗任何上游资源）
  const ip = clientIp(req);
  const org = originOf(req);
  if (!org || !ALLOWED_ORIGINS.includes(org)) {
    return res.status(403).json({ code: 'ORIGIN_DENIED', error: 'Forbidden' });
  }

  // 2a) 突发限流兜底
  if (!burstCheck(ip)) {
    return res.status(429).json({ code: 'RATE_BURST', error: 'Too many requests, please slow down.' });
  }

  try {
    const body = await readBody(req);
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    if (!message) {
      return send(res, { reply: '请输入消息后再试。', code: 'EMPTY_MESSAGE' });
    }
    if (message.length > MAX_MSG_CHARS) {
      return send(res, { reply: '消息太长了，请缩短后再发。', code: 'MESSAGE_TOO_LONG' });
    }

    // 3) Turnstile 人机校验（配置后生效）
    if (!(await turnstileOk(body.cfToken, ip))) {
      return res.status(403).json({ code: 'CAPTCHA_FAILED', error: 'Verification failed, please refresh and try again.' });
    }

    if (!ARK_KEY) {
      return send(res, { reply: 'AI 服务配置中，请稍后再试。', code: 'NO_API_KEY' });
    }

    // 2b) KV 跨实例每日硬限额（配置后生效）
    const usedToday = await kvDailyCount(ip);
    if (usedToday > DAILY_LIMIT) {
      return res.status(429).json({ code: 'DAILY_LIMIT', error: 'Daily AI limit reached, please continue tomorrow or upgrade.' });
    }

    let upstream;
    try {
      upstream = await withTimeout(fetch(ARK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ARK_KEY}`
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            {
              role: 'system',
              content: '你是一个专业的中文老师，和用户练习中文对话。回答简短自然，用中文回复，附带拼音和英文解释。每次回复控制在 2-3 句话。'
            },
            { role: 'user', content: message }
          ],
          temperature: 0.7,
          max_tokens: MAX_TOKENS
        })
      }), UPSTREAM_TIMEOUT_MS, 'UPSTREAM_TIMEOUT');
    } catch (netErr) {
      console.error('LLM network error:', netErr && netErr.message);
      return send(res, {
        reply: 'AI 服务暂时连不上，请稍后再试。',
        code: 'UPSTREAM_UNREACHABLE',
        model: MODEL,
        detail: String((netErr && netErr.message) || '').slice(0, 200)
      });
    }

    let data = {};
    try { data = await upstream.json(); } catch (e) { data = {}; }

    if (!upstream.ok || !data.choices || !data.choices.length) {
      const errMsg = (data && data.error && data.error.message) || data.message || ('HTTP ' + upstream.status);
      const errCode = (data && data.error && data.error.code) || ('UPSTREAM_' + upstream.status);
      console.error('LLM upstream error:', upstream.status, errCode, errMsg, '| model=', MODEL);
      return send(res, {
        reply: 'AI 模型暂时不可用，请稍后再试。',
        code: errCode,
        detail: String(errMsg).slice(0, 300),
        model: MODEL
      });
    }

    const reply = (data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '抱歉，我现在无法回答。';
    return send(res, { reply });
  } catch (error) {
    console.error('Chat API error:', error);
    return send(res, {
      reply: '网络错误，请稍后再试。',
      code: 'HANDLER_ERROR',
      detail: String((error && error.message) || '').slice(0, 200)
    });
  }
}
