#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成 QR 双基准数据，供 tools/check-qr.mjs 使用。
===============================================================================
为什么需要它
assets/js/core/qr.js 是自研的 QR 编码器。自研编码器最危险的失败模式是
「看起来像二维码、扫不出来」——结构、掩码、数据填充、纠错分块任一处写错都会这样，
而界面上肉眼完全看不出来。所以必须有独立实现产出的基准做锚点。

两个基准，各司其职：

  基准 A —— python-qrcode（编码正确性）
      用于逐模块比对我们的编码器输出。选它的原因是它的填充逻辑符合
      ISO/IEC 18004 7.4.10：只在「不在码字边界上」时才补零。
      比对时会强制使用同一个掩码，因此排除「掩码择优不同」这一合法差异。

  基准 B —— segno（解码正确性）
      用于验证我们的解码器能读懂别人生成的二维码。这样编码与解码两条路径
      各自都有外部锚点，而不是互相自证。

关于 segno 的一个已知偏差（记录在案，不影响本测试）
      segno/encoder.py 的 write_padding_bits 在字节已对齐时仍会补 8 个零位
      （`buff.extend([0] * (8 - (length % 8)))` 未做 `length % 8` 判断），
      与它自己引用的规范文字「若不在码字边界上才补零」不一致。
      后果是数据段多一个 0x00 字节，随后纠错码字随之变化，矩阵整体不同。
      两种产物都是合法、可扫描的二维码；我们按规范实现，因此不向 segno 靠拢。
      （当数据恰好占满容量时，segno 多补的位会因超出容量被丢弃，此时两者一致。）

本脚本与两个库只用于**测试期**生成基准数据，绝不进入站点产物。
站点仍然零依赖——浏览器里跑的只有 assets/js/core/qr.js。

用法（pip install qrcode segno）
    python tools/qr-reference-gen.py
产出
    tools/qr-reference.json
"""

import json
import pathlib
import sys

try:
    import qrcode
    from qrcode.util import QRData, MODE_8BIT_BYTE
    from qrcode.constants import ERROR_CORRECT_M
except ImportError:
    sys.exit("缺少 qrcode，请先执行：pip install qrcode")

try:
    import importlib.metadata as metadata
    QRC_LIB_VERSION = metadata.version("qrcode")
except Exception:                                        # pragma: no cover
    QRC_LIB_VERSION = "unknown"

try:
    import segno
    SEGNO_VERSION = segno.__version__
except ImportError:
    segno = None
    SEGNO_VERSION = None

ROOT = pathlib.Path(__file__).resolve().parent

# 用例：版本 1–7 全覆盖。
# 后 4 条是真实形态的合盘链接（44 字符域名路径 + 各 19 字符的答案编码）。
CASES = [
    ("v1-short-bytes", "HELLO"),
    ("v2-short-url", "https://a.dev/d?a=ABCDEFG"),
    ("v3-utf8-cjk", "依恋地图 · 双人合盘"),
    ("v4-invite-a-only", "https://am.dev/duo.html?a=ABCDEFGHIJKLMNOPQRS"),
    ("v5-real-invite", "https://attachment-map.pages.dev/duo.html?a=ABCDEFGHIJKLMNOPQRS"),
    ("v6-real-duo", "https://attachment-map.pages.dev/duo.html?a=ABCDEFGHIJKLMNOPQRS&b=TUVWXYZ0123456789ABC"),
    ("v7-long-duo", "https://attachment-map.pages.dev/duo.html?a=" + "A" * 40 + "&b=" + "B" * 20),
    ("v7-at-capacity", "x" * 122),
]


def binary(matrix):
    return "\n".join("".join("1" if bit else "0" for bit in row) for row in matrix)


def from_qrcode(text, mask=None):
    """基准 A：python-qrcode。mask=None 表示由它自行择优。"""
    qr = qrcode.QRCode(
        version=None,
        error_correction=ERROR_CORRECT_M,
        border=0,
        box_size=1,
        mask_pattern=mask,
    )
    qr.add_data(QRData(text, mode=MODE_8BIT_BYTE))     # 固定为 Byte 模式，禁止自动分段
    qr.make(fit=True)
    return qr


def from_segno(text):
    return segno.make(text, error="m", mode="byte", micro=False, boost_error=False)


def main():
    out = {
        "note": "QR 双基准数据；由 tools/qr-reference-gen.py 生成，请勿手工编辑",
        "generatorA": {
            "name": "python-qrcode",
            "version": QRC_LIB_VERSION,
            "role": "编码器基准：逐模块完全一致（强制同一掩码）",
        },
        "generatorB": {
            "name": "segno",
            "version": SEGNO_VERSION,
            "role": "解码器基准：独立实现产出的合法二维码，需能被我们的解码器读回",
        },
        "cases": [],
    }

    for name, text in CASES:
        entry = {
            "name": name,
            "text": text,
            "byteLength": len(text.encode("utf-8")),
            "a": None,
            "b": None,
        }

        # --- 基准 A：8 个掩码全部导出，比对时可任选 ---
        masks = {}
        version = None
        size = None
        for mask in range(8):
            qr = from_qrcode(text, mask)
            rows = [list(row) for row in qr.modules]
            version = qr.version
            size = len(rows)
            masks[str(mask)] = binary(rows)

        # 罚分函数的 argmin（与我们的择优实现做一致性对照）。
        #
        # 注意：这里刻意不用 python-qrcode 的 best_mask_pattern()。它在打分时调用
        # makeImpl(test=True)，会把格式信息位全部清成浅色再算分，因此得出的不是
        # 最终矩阵上的真正最小值。改为在最终矩阵上直接调用它的 lost_point()，
        # 这才是与我们可比的口径。
        scores = [qrcode.util.lost_point(
            [list(map(int, line)) for line in masks[str(i)].split("\n")]
        ) for i in range(8)]
        auto_mask = scores.index(min(scores))

        entry["a"] = {
            "version": version,
            "size": size,
            "penaltyArgmin": int(auto_mask),
            "penaltyScores": scores,
            "matrices": masks,
        }

        # --- 基准 B：segno 自动择优掩码，只存矩阵 ---
        if segno is not None:
            sq = from_segno(text)
            entry["b"] = {
                "version": int(sq.version),
                "size": len(list(sq.matrix)),
                "mask": int(sq.mask),
                "matrix": binary(list(sq.matrix)),
            }

        out["cases"].append(entry)
        print(f"  {name:20s} A: V{version} {size}x{size} ｜ B: "
              + (f"V{entry['b']['version']} mask={entry['b']['mask']}" if entry["b"] else "跳过"))

    target = ROOT / "qr-reference.json"
    target.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"\n已写入 {target}")
    print(f"  python-qrcode {QRC_LIB_VERSION} ｜ segno {SEGNO_VERSION}")


if __name__ == "__main__":
    main()
