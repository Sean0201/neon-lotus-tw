"""
rack-cutout.py — 首頁衣架用去背圖
--------------------------------------------------------------------
商品照 → 開源模型去背 (rembg / isnet-general-use) → 裁掉透明邊 → 寬 560px 透明 WebP
輸出後到後台「精選商品」編輯視窗的「衣架去背圖」上傳即可。

一次性安裝(需要 Python 3.9–3.13;rembg 目前不支援 3.14):
  /usr/bin/python3 -m venv ~/.venvs/rembg
  ~/.venvs/rembg/bin/pip install "rembg[cpu]"
  (第一次執行會自動下載模型 isnet-general-use.onnx 約 170MB 到 ~/.u2net/)

用法:
  ~/.venvs/rembg/bin/python scripts/rack-cutout.py <商品照> [<輸出.webp>]
  ~/.venvs/rembg/bin/python scripts/rack-cutout.py photo1.jpg photo2.jpg ...   # 批次,輸出到 output/rack/

建議用白底平拍的商品照(不要模特兒穿搭照),去背最乾淨。
"""
import sys
from pathlib import Path

from PIL import Image
from rembg import new_session, remove

WIDTH = 560
OUT_DIR = Path(__file__).resolve().parent.parent / "output" / "rack"


def cutout(src: Path, dst: Path, session) -> None:
    img = Image.open(src).convert("RGB")
    cut = remove(
        img, session=session, alpha_matting=True,
        alpha_matting_foreground_threshold=240,
        alpha_matting_background_threshold=15,
        alpha_matting_erode_size=8,
    )
    bbox = cut.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox()
    if not bbox:
        print(f"✗ {src.name}: 找不到主體,略過")
        return
    cut = cut.crop(bbox)
    if cut.width > WIDTH:
        cut = cut.resize((WIDTH, round(cut.height * WIDTH / cut.width)), Image.LANCZOS)
    dst.parent.mkdir(parents=True, exist_ok=True)
    cut.save(dst, "WEBP", quality=88, method=6)
    print(f"✓ {src.name} → {dst} {cut.size[0]}x{cut.size[1]} {dst.stat().st_size // 1024}KB")


def main(argv: list[str]) -> None:
    if not argv:
        print(__doc__)
        sys.exit(1)
    session = new_session("isnet-general-use")
    if len(argv) == 2 and argv[1].lower().endswith(".webp"):
        cutout(Path(argv[0]), Path(argv[1]), session)
        return
    for a in argv:
        src = Path(a)
        cutout(src, OUT_DIR / f"{src.stem}.webp", session)


if __name__ == "__main__":
    main(sys.argv[1:])
