# HanVerse v5 Deploy Status (2026-10-06 · final pricing + shop + tutor contact)

## ✅ 已上线（线上实测通过 · 最终版 2026-10-06 16:44 UTC+8）

### v5.3 修复（2026-10-06 · 已上线 Vercel 线上实测通过）
- **PayPal 按钮 3×3 重复堆叠修复**：SDK URL 增加 `disable-funding=credit,card,paylater`，三个 plan（Annual/Monthly/Intro）各只渲染 1 个纯 PayPal 按钮，不再出现「PayPal 订购 / PayPal CREDIT / 借记卡或信用卡」×3 组的 9 按钮堆叠。
- **顶部导航账号入口**：桌面导航 Subscribe 旁新增 `Log in` / `Sign up`；移动端菜单同步新增。
- **合规页定稿（默认值）**：docs/legal/{privacy,terms,refund}.md 全部 [CONFIRM:] 占位符已替换、开发清单（## Items to confirm）段落已删除；默认值：主体 HanVerse、地址 China、客服/隐私邮箱 ppawhouse@gmail.com、管辖地中华人民共和国、退款窗口 14 天、兑换码退还 7 天、纠纷上报 30 天、响应 SLA 2 工作日、解决 SLA 10 工作日、日志留存 90 天、托管位置美国(Vercel)、最低年龄 13。
- 部署记录：main 最新 HEAD `a0c4fbdd`；线上 www.hanverse.app 实测：disable-funding ✅、导航登录（桌面+移动）✅、CONFIRM 占位符 0 ✅、Items 清单 0 ✅、管辖地 ✅、退款 14 天 ✅；邮箱被 Cloudflare Email Protection 混淆属正常现象（浏览器端自动解码显示）。
- 部署链路说明：v5.3 曾因 5 连 commit 触发 Vercel 中途部署（停在 index.html 未更新的中间 commit `9dabc6b6`）导致线上短暂只有 PayPal/导航修复；补推 deploy-status.md（`a0c4fbdd`）触发最终 HEAD 部署后，三项全部生效。

### 定价（最终版）
- **PayPal 三计划**（plan IDs 已从 Vercel env 注入 build，前端可见）：
  - `PAYPAL_PLAN_MONTHLY` = P-4V3472025F230033KNLCJ4HI → $6.99/月（Standard Monthly）
  - `PAYPAL_PLAN_PROMO`   = P-34B9575259554822PNLCJ5BY → $3.99/月（Intro，仅订阅页）
  - `PAYPAL_PLAN_ANNUAL`  = P-31814090U8192141DNLCJ55I → $69/年
- **微信**（不变）：¥39/月 · ¥19.99 引流 · ¥399/年
- 三个 PayPal 按钮在订阅页依次渲染（Annual / Monthly / Intro）

### 微信小店（v5.1 更新）
- 订阅页"Buy on WeChat Shop"大区块已移除（2026-10-06 v5.1）：支付入口只保留 **PayPal + WeChat Native 扫码** 两个，链路清晰
- 微信小店定位改为**直播/其它平台渠道**：客户在小店下单拿兑换码，回站订阅页 "Bought from our WeChat Shop / livestream? Activate your code" 填码激活
- 原店铺链接 https://store.weixin.qq.com/shop/a/dxKiU24WpLFMi7u 保留在代码常量 WECHAT_SHOP_URL 备用；`images/wechat-shop-qr.jpg` 仍部署（小店渠道物料）
- Native 区仍是登录后动态订单码（wxQrCanvas），两者不混淆

### AI Tutor 客服
- #/ai-tutor 顶部 "Need help? Contact us" 按钮 → 弹出 modal（遮罩/×/点遮罩均可关）
- modal 内 `images/wechat-qr.png`（伴学先生客服码）+ ppawhouse@gmail.com mailto
- api/chat.js system prompt 已更新：模型明确自己是 HanVerse、客服/付款/退款问题统一答微信扫码或邮箱、定价口径为 $6.99/$3.99/$69 与 ¥39/¥19.99/¥399

### 推荐奖励（v5.1 新增）
- 账号页新增 "Refer & earn" 区块：展示个人推荐链接 `https://www.hanverse.app/?ref=<邮箱>`，一键复制
- 规则：被推荐人（经 ?ref= 归因注册）成功激活**年卡 Y365**（兑换码激活 或 微信支付成功）→ 推荐人账号 +30 天 bonus
- 防刷：同一推荐人对同一被推荐人只奖励一次（KV `bonus:<ref>:<buyer>`）；不能自己推荐自己；推荐人必须已是注册账号
- bonus 计入 /api/me 权益合并（取所有来源最晚到期），ref 归因正则已扩展支持邮箱格式
- 触发点：api/redeem-code.js（路径 B Y365 激活）、api/wechat-notify.js（微信 Y365 支付成功）；PayPal 订阅路径暂不触发（订阅制无"购买1年"语义）

### 其他（同前）
- 18 路由全可达、0 console error
- 后端 12 个 api 函数全部注册（password 200 / wechat-pay 401 / wechat-notify 500 待配密钥）
- 100 城地标图竖版 {city}.jpg（-w 弃用，版权用户承担）
- 兑换码 CSV 20000+20000 已生成

## 🚧 微信支付 Native 打通（进行中 · 2026-10-06 晚）

### 已解决/已确认
- **认证类型修复已验证**：微信 APIv3 要求 Authorization 头用 `WECHATPAY2-SHA256-RSA2048`（旧格式 `WECHATPAY` 返回 401 SIGN_ERROR "Http头Authorization认证类型不正确"）。已改 `api/wechat-pay.js`，本地直连微信 API 实测 **200 + code_url** ✅。
- **api/ 冗余清理**：GitHub 仓库 api/ 目录此前 13 个文件（含冗余 wechat-create-order.js），超出 Vercel Hobby **每部署 12 函数硬上限** → 导致 Vercel 部署失败。已删除该冗余文件，现 GitHub api/ = **12 个文件**（chat / check-pro / login / logout / me / password / paypal-webhook / redeem-code / register / verify-email / wechat-notify / wechat-pay），本地 5 个冗余副本移入 `_scripts/api-archive/`。
- **wechat-pay.js 加固**：微信 API 调用加 `AbortSignal.timeout(8000)` 与原始错误体透出（不再吞掉微信真实错误）；vercel.json 为 wechat-pay/wechat-notify 配 maxDuration 30。
- **线上函数存活确认**：`/api/wechat-pay` 无 token 返回 401 JSON（函数活着）；`/api/wechat-notify` 无签名返回 400 invalid signature（平台公钥已生效）。

### 当前卡点（非代码问题）
- **Vercel Hobby 构建速率限制（build-rate-limit）**：GitHub 最新 HEAD `a598f598` 的 Vercel 部署状态 = **failure**，错误链接指向 `upgradeToPro=build-rate-limit`。连续推送多个 commit 各触发一次自动构建 + 当日多次部署，超出 Hobby 免费版构建配额 → 最新代码**尚未部署上线**，线上仍跑旧 wechat-pay.js（WECHATPAY 旧认证 → 微信 401 → 平台 502）。
- 解法：等配额恢复（Hobby 按小时/日滚动）后 Vercel 会自动部署最新 HEAD；或用户在 Vercel Dashboard 手动 Redeploy（Production Deployment → Redeploy）；或升级 Pro。
- 部署成功后的预期：`POST /api/wechat-pay {action:'create',sku:'M30'}`（带 Bearer token）返回 200 + code_url，前端 Native 区渲染微信扫码支付。

## 📦 兑换码 CSV
- `shop-assets\codes-monthly-20000.csv`
- `shop-assets\codes-yearly-20000.csv`

## 🔑 用户需在 Vercel 配置的环境变量
`AUTH_SECRET`（值在 `_scripts\.auth.env`，2026-10-06 已生成）、`CODE_SIGNING_SECRET`（值在 `_scripts\.code_signing.env`）、`RESEND_API_KEY`、`WECHAT_MCH_ID`、`WECHAT_APPID`、`WECHAT_CERT_SERIAL_NO`、`WECHAT_PRIVATE_KEY`、`WECHAT_API_V3_KEY`、`WECHAT_PLATFORM_PUBLIC_KEY`。
已就绪：PayPal plan IDs × 3、PAYPAL_LIVE_CLIENT_SECRET、KV_*。

## 📋 用户待操作
1. ~~配上述 9 个环境变量~~（AUTH_SECRET + CODE_SIGNING_SECRET 已配；微信 6 项凭证已归档到 `_scripts\.wechat.env`，**待填 Vercel 并 Redeploy**）。
2. 微信商户 APIv3 + Native 支付开通：6 个 `WECHAT_*` 变量（MCH_ID / APPID / CERT_SERIAL_NO / PRIVATE_KEY / API_V3_KEY / PLATFORM_PUBLIC_KEY）→ Vercel Settings → Environment Variables → Save → Redeploy；公钥 ID `PUB_KEY_ID_0117512605572026100200211802001800` 已备案（代码未强制校验）。
3. 两份 CSV 导入阿奇索自动发货。
4. ~~Vercel Redeploy~~（v5.3 三项修复已上线，线上实测通过）。
5. 合规页默认值确认/替换：若需正式主体名称/地址/邮箱，替换 docs/legal/*.md 后重跑 build.py 并推送（Vercel 自动部署）。
6. 轮换 GitHub PAT 与 MiniMax key；CODE_SIGNING_SECRET 勿外泄。

## 🚧 已知限制
- Vercel Hobby 函数上限 12：当前 api/ 正好 12 个文件。加新端点需合并或升级 Pro。
