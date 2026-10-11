# -*- coding: utf-8 -*-
"""下载 qrcode.min.js 到 vendor/ 目录（自托管，绕开 cdn.jsdelivr.net / bootcdn 中国境内不可达）。

正确 URL 是 soldair/qrcode 的 npm `build/qrcode.min.js`（不是 `qrcodejs/`，也不是 `qrcode@1.5.3/build/`）。
   - jsdelivr 最新（直接 npm）：https://cdn.jsdelivr.net/npm/qrcode/build/qrcode.min.js  ← 优先
   - cdnjs 1.4.4（云端手工同步）：https://cdnjs.cloudflare.com/ajax/libs/qrcode/1.4.4/qrcode.min.js
   - unpkg 备选：https://unpkg.com/qrcode/build/qrcode.min.js

API：UMD，暴露全局 `QRCode`，含 `QRCode.toCanvas(canvas, text, options, callback)` —— 与原代码 100% 兼容。
幂等：已存在且大小合理则跳过。
"""
import os, sys, hashlib, urllib.request, urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT  = os.path.join(ROOT, "vendor", "qrcode.min.js")

SOURCES = [
    ("jsdelivr",   "https://cdn.jsdelivr.net/npm/qrcode/build/qrcode.min.js"),
    ("cdnjs",      "https://cdnjs.cloudflare.com/ajax/libs/qrcode/1.4.4/qrcode.min.js"),
    ("unpkg",      "https://unpkg.com/qrcode/build/qrcode.min.js"),
]
EXPECTED_SIZE_MIN = 8000   # 实测约 13-17 KB；<8KB 视为不完整

def fetch(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": "HanVerse-fetch/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()

def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)

    if os.path.exists(OUT):
        cur = os.path.getsize(OUT)
        if cur >= EXPECTED_SIZE_MIN:
            print(f"[skip] vendor/qrcode.min.js 已存在 {cur} B（≥{EXPECTED_SIZE_MIN}）")
            return 0
        print(f"[redo] vendor/qrcode.min.js 存在但仅 {cur} B，重新下载")

    last_err = None
    for tag, url in SOURCES:
        try:
            print(f"[try] {tag}: {url}")
            data = fetch(url)
            size = len(data)
            if size < EXPECTED_SIZE_MIN:
                print(f"  ⚠️ 仅 {size} B，跳过")
                continue
            # 简单内容校验：UMD 应包含 QRCode.toCanvas（出现在文件末尾的 export 段）
            content_str = data.decode("utf-8", errors="ignore")
            if "toCanvas" not in content_str or "QRCode" not in content_str[:1024]:
                print(f"  ⚠️ 内容不像 soldair qrcode（缺少 toCanvas 或 QRCode 头部），跳过")
                continue
            sha = hashlib.sha256(data).hexdigest()[:12]
            with open(OUT, "wb") as f:
                f.write(data)
            print(f"  ✅ 写入 {OUT}：{size} B，sha256={sha}…")
            return 0
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            print(f"  ❌ {e}")
            last_err = e
        except Exception as e:
            print(f"  ❌ {e}")
            last_err = e

    print(f"\n[fail] 三个源都不可用：{last_err}", file=sys.stderr)
    return 1

if __name__ == "__main__":
    sys.exit(main())