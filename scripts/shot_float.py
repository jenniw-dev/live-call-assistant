"""浮窗界面截图（开发自测用）：headless Chrome + CDP 注入示例历史 → ?float=1 → 展开 → 截屏。"""
import asyncio
import base64
import json
import subprocess
import sys
import time

import httpx
import websockets

CHROME = r"C:\Users\lx\AppData\Local\Google\Chrome\Application\chrome.exe"
PORT = 9333
URL = "http://localhost:5173/?float=1"
OUT = sys.argv[1] if len(sys.argv) > 1 else "float_preview.png"

DEMO_ITEM = {
    "id": "demo-1",
    "question": "那么GPT呢？",
    "response": {
        "answer": (
            "GPT系列是Decoder-only架构，靠自回归预测下一个token生成内容，"
            "天然适合对话和创作，但闭源、贵、无法私有化部署。\n\n"
            "**技术原理**：Transformer解码器堆叠 + RLHF对齐；推理侧可用KV Cache加速。\n"
            "**对比BERT**：BERT是encoder架构，适合理解类任务（分类/抽取），生成能力弱。\n"
            "**项目选择**：我们选Qwen本地部署，成本与数据合规更可控。"
        ),
        "source": "kb",
        "score": 0.72,
        "file": "ai大模型知识文档.md",
        "matched_question": "GPT系列模型的特点是什么？",
    },
    "timestamp": int(time.time() * 1000),
    "streaming": False,
}


async def main():
    proc = subprocess.Popen(
        [CHROME, f"--remote-debugging-port={PORT}", "--headless=new",
         "--window-size=780,940", "--hide-scrollbars",
         "--user-data-dir=C:/tmp/chrome-float-shot", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        ws_url = None
        for _ in range(40):
            try:
                r = httpx.get(f"http://127.0.0.1:{PORT}/json", timeout=2)
                pages = [p for p in r.json() if p.get("type") == "page"]
                if pages:
                    ws_url = pages[0]["webSocketDebuggerUrl"]
                    break
            except Exception:
                await asyncio.sleep(0.5)
        if not ws_url:
            print("chrome devtools not ready"); return

        async with websockets.connect(ws_url, max_size=None) as ws:
            mid = 0

            async def send(method, params=None):
                nonlocal mid
                mid += 1
                await ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
                while True:
                    msg = json.loads(await ws.recv())
                    if msg.get("id") == mid:
                        return msg

            await send("Page.enable")
            await send("Runtime.enable")
            await send("Page.navigate", {"url": URL})
            await asyncio.sleep(3)

            # 注入示例历史（localStorage）后重载
            seed = json.dumps([DEMO_ITEM], ensure_ascii=False)
            await send("Runtime.evaluate", {
                "expression": f"localStorage.setItem('aic_chat_history_v1', {json.dumps(seed)})",
            })
            await send("Page.navigate", {"url": URL})
            await asyncio.sleep(3)

            # 双击迷你浮窗 → 展开态
            await send("Runtime.evaluate", {
                "expression": (
                    "(() => { const el = document.querySelector('.float-mini');"
                    " if (el) el.dispatchEvent(new MouseEvent('dblclick', {bubbles:true,cancelable:true}));"
                    " return !!el; })()"
                ),
            })
            await asyncio.sleep(1.0)

            shot = await send("Page.captureScreenshot", {"format": "png"})
            data = shot.get("result", {}).get("data")
            if not data:
                print("screenshot failed"); return
            with open(OUT, "wb") as f:
                f.write(base64.b64decode(data))
            print("saved:", OUT)
    finally:
        proc.terminate()


asyncio.run(main())
