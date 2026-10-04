// 临时诊断端点：用现有密钥实测 BytePlus 国际端点（不回显密钥）。定位后立即删除。
function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' TIMEOUT ' + ms + 'ms')), ms))
  ]);
}

export default async function handler(req, res) {
  const KEY = process.env.DOUBAO_API_KEY || '';
  const out = { region: process.env.VERCEL_REGION || '?', hasKey: !!KEY, keyTail: KEY ? KEY.slice(-4) : null, targets: [] };

  const endpoints = [
    ['byteplus', 'https://ark.ap-southeast.bytepluses.com/api/v3/chat/completions', 'doubao-pro-32k'],
    ['ark-bj', 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', 'doubao-pro-32k']
  ];
  for (const [name, url, model] of endpoints) {
    const t = Date.now();
    try {
      const r = await withTimeout(fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] })
      }), 8000, name);
      const txt = (await r.text()).slice(0, 400);
      out.targets.push({ name, status: r.status, ms: Date.now() - t, body: txt });
    } catch (e) {
      out.targets.push({ name, error: e.name + ': ' + e.message, ms: Date.now() - t });
    }
  }
  res.status(200).json(out);
}
