#!/usr/bin/env python3
"""把 out/frames/<流程>/NN.png 合成带说明文字的 GIF，写到 out/gifs/。

每帧顶部加一条说明和“fixture 预览，非生产原生验收”水印。
用法：python3 make_gifs.py
"""
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "out"
FONT = "/System/Library/Fonts/Hiragino Sans GB.ttc"
MAX_WIDTH = 1000
FRAME_MS = 1500

TITLES = {
    "pill-cancel": "胶囊：点开 → 逐个取消订阅 → 数字递减 → 清零后胶囊消失",
    "pill-jump": "胶囊：点开 → 打开全局订阅页 → 打开订阅所在会话",
    "two-sessions": "两个会话：各自独立的胶囊和弹出层",
    "compact-sheet": "窄屏：胶囊变底部面板 → 取消订阅",
    "page-cancel": "订阅页取消订阅 → 回到会话，胶囊数量同步",
    "token": "令牌输入：密文 → 保存后清空 → 失败脱敏 → 移除",
    "settings": "设置：关闭影子模式 → 校验 → 保存",
}


def main() -> None:
    labels = json.loads((OUT / "results.json").read_text())["labels"]
    font = ImageFont.truetype(FONT, 16)
    small = ImageFont.truetype(FONT, 13)
    gifs = OUT / "gifs"
    gifs.mkdir(parents=True, exist_ok=True)
    for flow_dir in sorted((OUT / "frames").iterdir()):
        flow = flow_dir.name
        frames = []
        for index, path in enumerate(sorted(flow_dir.glob("*.png"))):
            image = Image.open(path).convert("RGB")
            if image.width > MAX_WIDTH:
                image = image.resize((MAX_WIDTH, round(image.height * MAX_WIDTH / image.width)))
            bar = 54
            canvas = Image.new("RGB", (image.width, image.height + bar), "#1f1f22")
            canvas.paste(image, (0, bar))
            draw = ImageDraw.Draw(canvas)
            step = labels[flow][index]
            draw.text((10, 6), f"{TITLES.get(flow, flow)}  ·  第 {index + 1} 步", font=small, fill="#bdbdc4")
            draw.text((10, 27), step, font=font, fill="#ffffff")
            frames.append(canvas.quantize(colors=128, method=Image.Quantize.MEDIANCUT))
        frames[0].save(
            gifs / f"{flow}.gif",
            save_all=True,
            append_images=frames[1:],
            duration=FRAME_MS,
            loop=0,
            optimize=True,
        )
        print(f"{flow}: {len(frames)} 帧 -> {gifs / (flow + '.gif')}")


if __name__ == "__main__":
    main()
