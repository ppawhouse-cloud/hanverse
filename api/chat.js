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

// 模型名优先取环境变量 ARK_MODEL / DOUBAO_MODEL（可填模型名或推理接入点 ep-xxxx），默认 doubao-pro-32k
const MODEL = process.env.ARK_MODEL || process.env.DOUBAO_MODEL || 'doubao-pro-32k';
const ARK_URL = process.env.ARK_URL || 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = await readBody(req);
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    if (!message) {
      return res.status(400).json({ reply: '请输入消息后再试。' });
    }

    const apiKey = process.env.DOUBAO_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ reply: 'AI 服务配置中，请稍后再试。', code: 'NO_API_KEY' });
    }

    // 调用火山方舟（简单 fetch，与此前已验证可连通的写法保持一致）
    let ark;
    try {
      ark = await fetch(ARK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
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
      });
    } catch (netErr) {
      console.error('Ark network error:', netErr && netErr.message);
      return res.status(502).json({ reply: 'AI 服务暂时连不上，请稍后再试。', code: 'ARK_UNREACHABLE', model: MODEL });
    }

    let data = {};
    try { data = await ark.json(); } catch (e) { data = {}; }

    // 上游非 2xx 或没有 choices：透传方舟错误码/信息（不含密钥），便于定位模型未开通/鉴权问题
    if (!ark.ok || !data.choices || !data.choices.length) {
      const errMsg = (data && data.error && data.error.message) || data.message || ('Ark HTTP ' + ark.status);
      const errCode = (data && data.error && data.error.code) || ('ARK_' + ark.status);
      console.error('Ark error:', ark.status, errCode, errMsg, '| model=', MODEL);
      return res.status(502).json({
        reply: 'AI 模型暂时不可用，请稍后再试。',
        code: errCode,
        detail: String(errMsg).slice(0, 300),
        model: MODEL
      });
    }

    const reply = (data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '抱歉，我现在无法回答。';
    return res.status(200).json({ reply });

  } catch (error) {
    console.error('Chat API error:', error);
    return res.status(500).json({ reply: '网络错误，请稍后再试。', code: 'HANDLER_ERROR' });
  }
}
