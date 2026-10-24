"""
Генератор иконок приложения (PWA / Android / iOS).

Запуск:
    /home/user/.venv/bin/python tools/make_icons.py

Картинки рисуются кодом, поэтому в репозитории нет «магических» бинарников
неизвестного происхождения: любую иконку можно пересобрать одной командой.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "frontend" / "icons"
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

# градиент логотипа: коралловый → фиолетовый (совпадает с акцентом тем)
TOP = (255, 95, 109)
BOTTOM = (124, 58, 237)


def gradient(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size))
    px = img.load()
    for y in range(size):
        t = y / max(1, size - 1)
        r = int(TOP[0] + (BOTTOM[0] - TOP[0]) * t)
        g = int(TOP[1] + (BOTTOM[1] - TOP[1]) * t)
        b = int(TOP[2] + (BOTTOM[2] - TOP[2]) * t)
        for x in range(size):
            # лёгкий диагональный блик
            d = (x / max(1, size - 1) + y / max(1, size - 1)) / 2
            k = 1 + 0.14 * (1 - d)
            px[x, y] = (min(255, int(r * k)), min(255, int(g * k)), min(255, int(b * k)), 255)
    return img


def rounded_mask(size: int, radius_ratio: float) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    radius = int(size * radius_ratio)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def icon(size: int, maskable: bool = False) -> Image.Image:
    base = gradient(size)

    if maskable:
        # maskable-иконка: фон во весь квадрат, логотип в безопасной зоне (60%)
        img = base
        logo_ratio = 0.52
    else:
        img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        img.paste(base, (0, 0), rounded_mask(size, 0.22))
        logo_ratio = 0.62

    draw = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONT, int(size * logo_ratio))

    # белая «S» по центру + мягкая тень
    text = "S"
    box = draw.textbbox((0, 0), text, font=font)
    tw, th = box[2] - box[0], box[3] - box[1]
    x = (size - tw) / 2 - box[0]
    y = (size - th) / 2 - box[1]

    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).text((x, y + size * 0.012), text, font=font, fill=(0, 0, 0, 90))
    img.alpha_composite(shadow.filter(__import__("PIL.ImageFilter", fromlist=["GaussianBlur"]).GaussianBlur(size * 0.012)))

    draw = ImageDraw.Draw(img)
    draw.text((x, y), text, font=font, fill=(255, 255, 255, 255))
    return img


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    targets = [
        ("icon-64.png", 64, False),
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("icon-maskable-512.png", 512, True),
        ("apple-touch-icon.png", 180, False),
    ]
    for name, size, maskable in targets:
        img = icon(size, maskable)
        img.save(OUT / name, "PNG", optimize=True)
        print("✓", name, f"{size}×{size}", (OUT / name).stat().st_size, "байт")


if __name__ == "__main__":
    main()
