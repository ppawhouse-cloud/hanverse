// HanVerse AI Tutor 后端（Vercel Node Serverless Function）
//
// 重要：海外 Vercel 节点（已固定 hkg1 香港）无法访问火山方舟北京 endpoint
//   https://ark.cn-beijing.volces.com  —— 跨境静默超时不可达。
// 因此默认改用火山引擎国际版 BytePlus（新加坡，与豆包/方舟同源、OpenAI 兼容）：
//   https://ark.ap-southeast.bytepluses.com/api/v3/chat/completions
// 也兼容 DeepSeek 等任意 OpenAI 兼容端点，全部经环境变量配置，无需改代码：
//   ARK_URL                         完整 chat/completions 地址（默认 BytePlus 新加坡）
//   ARK_API_KEY 或 DOUBAO_API_KEY   密钥（国内方舟 key 在国际版不通用）
//   ARK_MODEL 或 DOUBAO_MODEL       模型名或推理接入点 ep-xxxx
//
// 注意：站点经 Cloudflare 代理，函数若返回 502/503/504 等网关状态码，响应体会被
// 代理错误页替换。故本函数统一以 HTTP 200 + 业务 code 返回，前端始终能拿到 JSON。

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

const ARK_URL = process.env.ARK_URL || 'https://ark.ap-southeast.bytepluses.com/api/v3/chat/completions';
const ARK_KEY = process.env.ARK_API_KEY || process.env.DOUBAO_API_KEY || '';
const MODEL = process.env.ARK_MODEL || process.env.DOUBAO_MODEL || 'doubao-pro-32k';

function send(res, payload) {
  return res.status(200).json(payload);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = await readBody(req);
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    if (!message) {
      return send(res, { reply: '请输入消息后再试。', code: 'EMPTY_MESSAGE' });
    }
    if (!ARK_KEY) {
      return send(res, { reply: 'AI 服务配置中，请稍后再试。', code: 'NO_API_KEY' });
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
          temperature: 0.7
        })
      }), 15000, 'UPSTREAM_TIMEOUT');
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
