# HanVerse 翻译质量管线（i18n quality pipeline）

所有面向学习者的中英对照内容，都必须经过本管线校对，确保**英文地道、语法零硬伤、拼音规范**。
语言学习产品对低级翻译错误零容忍（例如曾出现 "Please give me three bottles of." —— 悬空 of）。

## 管什么

`_content/` 下 14 个 JSON 的全部中英对照，共两类翻译单元：

- **tri**（词条/例句）：字段 `zh / py / en`，分布在 chinese101、culture、places、sentences 及各 scenes 的 words。
- **line**（场景对话行）：字段 `text / pinyin / en`（words 内嵌 tri）。

管线递归收集、按中文原文全局去重后送模型，当前规模约 **3975 个唯一中文串 / 6429 个翻译点**。

## 文件

| 文件 | 作用 | 是否调模型 |
| --- | --- | ---|
| `translate_pipeline.py` | 收集单元→按 zh 去重→MiniMax 校对/重译→写缓存；并发、退避重试、拆批兜底、断点续跑 | 是（需 key） |
| `translation_cache.json` | 翻译记忆库（zh → {zh,py,en}），增量翻译时复用，勿手改 | 产物 |
| `apply_translations.py` | 按中文原文把缓存回填到 14 个 JSON，保持原缩进；默认 dry-run，`--write` 落盘 | 否 |
| `pinyin_fix.py` | 拼音确定性后处理：整句句首大写、数词+量词分写、删音节间误点、`nǐhǎo→nǐ hǎo` 等；默认 dry-run，`--write` 落盘 | 否 |
| `qc_after.py` | 精准二次质检，导出 `qc_issues.json`；区分词条与句子，规避合法语法误报 | 否 |

## 标准流程（新增/改动 `_content` 内容后）

```powershell
# 0) 设置 MiniMax key（仅当前用户环境变量，切勿写进任何文件/仓库）
$env:MINIMAX_API_KEY = "sk-..."

# 1) 校对/重译（增量：只处理缓存里没有的新中文串；全量约 20 分钟）
python _scripts/i18n/translate_pipeline.py
#   小批量自测：python _scripts/i18n/translate_pipeline.py --limit 40

# 2) 回填内容（先看 dry-run，确认命中/缺失再落盘）
python _scripts/i18n/apply_translations.py
python _scripts/i18n/apply_translations.py --write

# 3) 拼音规范化（先 dry-run 再 --write；可重复运行，幂等）
python _scripts/i18n/pinyin_fix.py
python _scripts/i18n/pinyin_fix.py --write

# 4) 质检，必须「去重后待修复条目: 0」
python _scripts/i18n/qc_after.py

# 5) 重建站点并校验
python build.py

# 6) 提交 _content 与 index.html，推送后 Vercel 自动部署；线上带 ?cb= 破缓存复验
```

若 QC 仍报个别条目，可定点修正 `_content` 后重跑 3–4；大面积问题则回到第 1 步。

## MiniMax 接入要点（踩过的坑）

- 用**国内站** `https://api.minimax.chat/v1/text/chatcompletion_v2`，模型 `MiniMax-Text-01`；国际站 `api.minimax.io` 返回 2049 invalid key，不可用。
- 请求体 `{model, messages, temperature:0.2, max_tokens}`；**不要**带 `response_format`（该模型不支持 JSON mode，带了会 HTTP 200 但 choices 为空、status_code=2013）。靠 prompt 约束输出 JSON 数组，代码侧容错解析。
- 成功判据：`base_resp.status_code == 0` 且取 `choices[0].message.content`。
- key 只从环境变量 `MINIMAX_API_KEY` 读取，**绝不入库、不入日志、不写死**。

## 翻译规则要点（已固化在 translate_pipeline.py 的 SYSTEM prompt）

- **词条 vs 完整句必须区别对待**：
  - 字词/短语用词典体——简洁释义、可 "/" 列近义、无句末标点、量词保留 "a pair of"、be 动词保留 "to be"。
  - 完整句/购物省略句必须是完整地道句子——首字母大写、带标点、补全宾语。
- 量词**禁止悬空介词**："请给我三瓶。" → "Three bottles, please."，绝不能是 "bottles of." / "pairs of."。
- 国籍词形：British / Canadian / French / German / American / Australian（不是 Britainn / Canadan / Francen / Germanyn）。
- 比较级：more convenient / quieter / cheaper（不是 convenienter）；不规则 better / worse / farther。
- 设施故障：实物 "The TV/toilet isn't working."；水电网用 "There's no hot water." / "The internet is down." / "The power is out."，不说 "the internet is broken"。
- 中文原句若为模板拼出的病句（如"我叫朋友"），先改写成自然句（"这是我朋友。"）再译。
- 拼音：标对声调、词儿连写、轻声不标调、儿化 yīdiǎnr、整句首字母大写、专名大写；数词与量词分写；禁止用句点分隔音节（`wéi.bō.lú` 是错的，应为 `wēibōlú`）。
- 固定译法：WeChat、Alipay、Kung Pao、Mapo tofu、fapiao、jin (500g)、yuan/kuai、官方拼音地名。

## 安全

- `MINIMAX_API_KEY`、部署 PAT、KV/支付密钥一律不放进本目录、不提交仓库。
- `translation_cache.json` 只含教学文案，不含任何密钥，可安全入库作为翻译记忆。
