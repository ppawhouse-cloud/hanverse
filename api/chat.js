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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
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
      return res.status(500).json({ reply: 'AI 服务配置中，请稍后再试。' });
    }

    const response = await fetch('https://ark.cn-beijing.volces.com/api/v3/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'doubao-pro-32k',
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

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || '抱歉，我现在无法回答。';

    res.status(200).json({ reply });

  } catch (error) {
    console.error('Chat API error:', error);
    res.status(500).json({ reply: '网络错误，请稍后再试。' });
  }
}
