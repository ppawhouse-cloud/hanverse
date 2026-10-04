// 临时诊断端点：报告函数区域与出站连通性（不含密钥）。定位 AI 问题后删除。
function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' TIMEOUT ' + ms + 'ms')), ms))
  ]);
}

export default async function handler(req, res) {
  const region = process.env.VERCEL_REGION || process.env.AWS_REGION || 'unknown';
  const targets = [
    ['ark-bj', 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', 'POST'],
    ['example', 'https://example.com', 'GET']
  ];
  const results = [];
  for (const [name, url, method] of targets) {
    const t = Date.now();
    try {
      const opts = { method, headers: { 'Content-Type': 'application/json' } };
      if (method === 'POST') opts.body = JSON.stringify({ model: 'doubao-pro-32k', messages: [] });
      const r = await withTimeout(fetch(url, opts), 8000, name);
      let txt = '';
      try { txt = (await r.text()).slice(0, 220); } catch (e) { txt = '(read body failed: ' + e.message + ')'; }
      results.push({ name, ok: true, status: r.status, ms: Date.now() - t, body: txt });
    } catch (e) {
      results.push({
        name, ok: false, ms: Date.now() - t,
        error: e.name + ': ' + e.message,
        code: e.code || (e.cause && e.cause.code) || undefined,
        cause: e.cause ? String(e.cause) : undefined
      });
    }
  }
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json({ region, node: process.version, results });
}
