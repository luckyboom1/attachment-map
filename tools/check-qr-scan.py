#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
端到端扫描验证：把 assets/js/core/qr.js 生成的 SVG 光栅化成像素，
交给 OpenCV 的真实二维码解码器读回来。
===============================================================================
为什么要这一步
前面的 tools/check-qr.mjs 已经证明我们的矩阵与 python-qrcode 逐模块一致。
但那只证明「矩阵算得对」，还差最后一环：**按这张矩阵铺出来的像素，
真能被扫描器读出来吗？** 自研二维码最危险的失败模式恰恰是
「结构看着对、相机就是扫不出来」，而且这种问题在浏览器里肉眼完全看不出来。

所以这里做像素级验证：SVG → 位图 → OpenCV QRCodeDetector → 必须还原出原始链接。
并且额外模拟三种真实场景的劣化：低分辨率、倾斜、模糊。

前置（仅本脚本需要，站点本身零依赖）
    pip install opencv-python-headless
    node tools/qr-svg-dump.mjs          # 先导出 SVG
    python tools/check-qr-scan.py

或者一步到位
    npm run check:qr:scan
"""

import json
import pathlib
import re
import sys

try:
    import cv2
    import numpy as np
except ImportError:
    sys.exit("缺少依赖，请先执行：pip install opencv-python-headless")

QUIET_ZONE = 4                       # 与 qrToSvg 的默认 margin 一致
PASS, FAIL = [], []


def report(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    mark = "✓" if ok else "✗"
    color = "\033[32m" if ok else "\033[31m"
    print(f"  {color}{mark}\033[0m {name}" + (f" — {detail}" if detail else ""))


def svg_to_grid(svg):
    """解析 SVG path，还原出含静默区的模块网格。"""
    view = re.search(r'viewBox="0 0 (\d+) (\d+)"', svg)
    if not view:
        raise ValueError("SVG 缺少 viewBox")
    n = int(view.group(1))
    if int(view.group(2)) != n or (n - 2 * QUIET_ZONE) % 4 != 1:
        raise ValueError(f"viewBox 尺寸 {n} 不合理")

    grid = np.zeros((n, n), dtype=np.uint8)
    marks = re.findall(r"M(\d+) (\d+)h1v1h-1z", svg)
    if not marks:
        raise ValueError("SVG 中没有任何模块方块")
    for x, y in marks:
        x, y = int(x), int(y)
        if not (0 <= x < n and 0 <= y < n):
            raise ValueError(f"模块坐标 ({x},{y}) 越界")
        grid[y, x] = 1
    return grid


def to_image(grid, scale):
    img = np.where(grid == 1, 0, 255).astype(np.uint8)
    return cv2.resize(img, (grid.shape[1] * scale, grid.shape[0] * scale),
                      interpolation=cv2.INTER_NEAREST)


def with_border(img, border):
    return cv2.copyMakeBorder(img, border, border, border, border,
                              cv2.BORDER_CONSTANT, value=255)


def rotate(img, angle):
    h, w = img.shape
    diag = int(np.ceil(np.hypot(h, w))) + 20
    canvas = np.full((diag, diag), 255, dtype=np.uint8)
    y0, x0 = (diag - h) // 2, (diag - w) // 2
    canvas[y0:y0 + h, x0:x0 + w] = img
    matrix = cv2.getRotationMatrix2D((diag / 2, diag / 2), angle, 1.0)
    return cv2.warpAffine(canvas, matrix, (diag, diag),
                          flags=cv2.INTER_NEAREST, borderValue=255)


def decode(img):
    detector = cv2.QRCodeDetector()
    text, _, _ = detector.detectAndDecode(img)
    return text


def main():
    path = pathlib.Path("/tmp/qr-scan-cases.json")
    if not path.exists():
        sys.exit("找不到 /tmp/qr-scan-cases.json，请先执行：node tools/qr-svg-dump.mjs")

    cases = json.loads(path.read_text(encoding="utf-8"))
    print(f"\nOpenCV {cv2.__version__} ｜ 用例 {len(cases)} 个\n")

    for case in cases:
        label, expected = case["label"], case["url"]
        grid = svg_to_grid(case["svg"])

        # 1) 基线：8 像素/模块，还原度足够高
        got = decode(to_image(grid, 8))
        report(f"{label} · 基线渲染可扫描（V{case['version']}）", got == expected,
               "" if got == expected else f"读到「{got[:40]}」")

        # 2) 低分辨率：3 像素/模块（相当于小屏幕上的一张小码）
        got = decode(to_image(grid, 3))
        report(f"{label} · 3 像素/模块仍可扫描", got == expected,
               "" if got == expected else f"读到「{got[:40]}」")

        # 3) 倾斜：手机扫屏幕上的码很少是正对的
        got = decode(rotate(with_border(to_image(grid, 6), 24), 12))
        report(f"{label} · 倾斜 12° 仍可扫描", got == expected,
               "" if got == expected else f"读到「{got[:40]}」")

        # 4) 模糊 + 噪点：模拟手持抖动与摄像头噪声
        img = to_image(grid, 6)
        img = cv2.GaussianBlur(img, (3, 3), 0)
        rng = np.random.default_rng(20260911)
        noise = rng.normal(0, 12, img.shape)
        img = np.clip(img.astype(np.float32) + noise, 0, 255).astype(np.uint8)
        got = decode(with_border(img, 24))
        report(f"{label} · 模糊加噪仍可扫描", got == expected,
               "" if got == expected else f"读到「{got[:40]}」")

        # 5) 负向对照：证明解码器确实在"读图"，而不是凭空给结果
        #    （a）纯噪声图必须读不出我们的链接
        #    （b）把右下角 45% 的模块涂白，损坏量远超纠错能力，必须读不出
        rng2 = np.random.default_rng(7)
        noise_img = rng2.integers(0, 2, size=(grid.shape[0] * 8, grid.shape[1] * 8),
                                  dtype=np.uint8) * 255
        got = decode(noise_img.astype(np.uint8))
        report(f"{label} · 纯噪声图读不出结果（负向对照）", got != expected,
               "" if got != expected else "噪声图竟读出了我们的链接")

        damaged = grid.copy()
        cut_r = int(grid.shape[0] * 0.55)
        cut_c = int(grid.shape[1] * 0.55)
        damaged[cut_r:, cut_c:] = 0
        got = decode(to_image(damaged, 8))
        report(f"{label} · 涂白右下 45%×45%（约 20% 模块）后读不出原文（负向对照）", got != expected,
               "" if got != expected else "损坏 20% 仍能读出，说明纠错判据异常")

    print("\n" + "─" * 64)
    if FAIL:
        print(f"\033[31m\033[1m{len(FAIL)} 项失败\033[0m  / 通过 {len(PASS)} 项")
        for name in FAIL:
            print(f"  · {name}")
        sys.exit(1)
    print(f"\033[32m\033[1m全部通过\033[0m  {len(PASS)} 项检查")


if __name__ == "__main__":
    main()
