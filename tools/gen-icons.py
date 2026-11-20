#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成扩展图标：圆角方块深蓝->深绿渐变 + 白色地球（经纬线）+ 时钟指针。

用法：python tools/gen-icons.py
输出：extension/icons/icon{16,32,48,128}.png
仅依赖 Pillow（本机内置）。
"""
from __future__ import annotations

import math
import os

from PIL import Image, ImageDraw
import numpy as np

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICON_DIR = os.path.join(PROJECT_ROOT, "extension", "icons")
SIZES = (16, 32, 48, 128)

# 深蓝 -> 深绿 渐变的两个端点
GRADIENT_TOP = (9, 33, 63)
GRADIENT_BOTTOM = (13, 122, 86)
WHITE = (255, 255, 255, 255)


def build_gradient(size: int) -> Image.Image:
    """生成竖直渐变底图（逐行插值）。"""
    t = np.linspace(0.0, 1.0, size, dtype=np.float64).reshape(size, 1, 1)
    top = np.array(GRADIENT_TOP, dtype=np.float64).reshape(1, 1, 3)
    bottom = np.array(GRADIENT_BOTTOM, dtype=np.float64).reshape(1, 1, 3)
    rows = top * (1.0 - t) + bottom * t
    rgb = np.repeat(rows, size, axis=1).astype(np.uint8)
    return Image.fromarray(rgb, mode="RGB").convert("RGBA")


def render(size: int) -> Image.Image:
    """渲染单张图标：先超采样再 LANCZOS 缩放，保证边缘干净。"""
    scale = 8 if size <= 32 else 4
    canvas_size = size * scale
    canvas = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))

    # 圆角方块底：内缩极小边距，圆角半径约 22%
    inset = canvas_size * 0.03
    box = (inset, inset, canvas_size - 1 - inset, canvas_size - 1 - inset)
    radius = canvas_size * 0.22
    mask = Image.new("L", (canvas_size, canvas_size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(box, radius=radius, fill=255)
    canvas.paste(build_gradient(canvas_size), (0, 0), mask)

    draw = ImageDraw.Draw(canvas)
    cx = canvas_size / 2.0
    cy = canvas_size / 2.0
    ring_r = canvas_size * 0.315
    stroke = max(1.0, canvas_size * (0.030 if size >= 48 else 0.040))

    # 地球：外圈
    draw.ellipse(
        [cx - ring_r, cy - ring_r, cx + ring_r, cy + ring_r],
        outline=WHITE,
        width=int(round(stroke)),
    )

    if size >= 32:
        # 纬线：用弦线绘制，天然被圆约束
        parallels = (-0.55, 0.0, 0.55) if size >= 48 else (0.0,)
        for f in parallels:
            dy = f * ring_r
            half = math.sqrt(max(ring_r * ring_r - dy * dy, 0.0))
            pad = stroke * 0.4
            draw.line(
                [cx - half + pad, cy + dy, cx + half - pad, cy + dy],
                fill=WHITE,
                width=max(1, int(round(stroke * 0.5))),
            )

    if size >= 48:
        # 经线：两个内切椭圆，均完全落在圆内
        for ratio in (0.40, 0.72):
            a = ring_r * ratio
            draw.ellipse(
                [cx - a, cy - ring_r, cx + a, cy + ring_r],
                outline=(255, 255, 255, 200),
                width=max(1, int(round(stroke * 0.42))),
            )

    # 时钟指针：10 点方向（短）+ 2 点方向（长），中心白点
    hand_w = max(1, int(round(stroke * (1.05 if size <= 32 else 0.85))))
    hour_len = ring_r * (0.50 if size <= 32 else 0.46)
    minute_len = ring_r * (0.92 if size <= 32 else 0.82)
    hx = cx + math.sin(math.radians(-60.0)) * hour_len
    hy = cy - math.cos(math.radians(-60.0)) * hour_len
    mx = cx + math.sin(math.radians(60.0)) * minute_len
    my = cy - math.cos(math.radians(60.0)) * minute_len

    # 先描深色底衬，保证指针在经纬线上依然清晰
    outline_color = (9, 33, 63, 220)
    outline_w = hand_w + max(1, int(round(stroke * 0.7)))
    draw.line([cx, cy, hx, hy], fill=outline_color, width=outline_w)
    draw.line([cx, cy, mx, my], fill=outline_color, width=outline_w)
    draw.line([cx, cy, hx, hy], fill=WHITE, width=hand_w)
    draw.line([cx, cy, mx, my], fill=WHITE, width=hand_w)

    dot = max(1.4, canvas_size * 0.030)
    draw.ellipse([cx - dot, cy - dot, cx + dot, cy + dot], fill=WHITE)

    return canvas.resize((size, size), Image.LANCZOS)


def main() -> int:
    os.makedirs(ICON_DIR, exist_ok=True)
    for size in SIZES:
        image = render(size)
        path = os.path.join(ICON_DIR, "icon%d.png" % size)
        image.save(path, "PNG", optimize=True)
        print("[gen-icons] %s (%d bytes)" % (os.path.relpath(path, PROJECT_ROOT), os.path.getsize(path)))
    print("[gen-icons] 完成：%d 张图标" % len(SIZES))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
