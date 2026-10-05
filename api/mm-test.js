// 临时诊断函数（不含任何密钥；key 由 POST body 传入，用完即删此文件与远端）
// 用于在 Vercel(hkg1 香港) 实测到 MiniMax 国内端点 api.minimaxi.com 的连通性与真实回复
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  let body = {};
  try {
    body = await new Promise((resolve, reject) => {
      let d = '';
      req.on('data', c => { d += c; });
      req.on('end', () => resolve(d ? JSON.parse(d) : {}));
      req.on('error', reject);
    });
  } catch (e) { return res.status(200).json({ parseError: String(e) }); }

  const { key, url, model, message } = body;
  const started = Date.now();
  try {
    const r = await Promise.race([
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: '你是一个专业的中文老师，和用户练习中文对话。回答简短自然，用中文回复，附带拼音和英文解释，每次2-3句。' },
            { role: 'user', content: message || '你好，请教我一句点牛肉面的中文。' }
          ],
          temperature: 0.7
        })
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT_12S')), 12000))
    ]);
    const txt = await r.text();
    return res.status(200).json({ up_status: r.status, ms: Date.now() - started, body: txt.slice(0, 1500) });
  } catch (e) {
    return res.status(200).json({ error: String(e), ms: Date.now() - started });
  }
}
