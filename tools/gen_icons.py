"""
Gerador de icones da extensao pAIdegua.

Usa apenas a biblioteca padrao do Python (struct, zlib). Nao depende de PIL,
Pillow, cairo ou qualquer coisa externa — util no ambiente Windows da JFCE
onde nem sempre se pode instalar pacotes Python.

Saida: icons/icon16.png, icon32.png, icon48.png, icon128.png

Design (logo "pAIdegua"):
    - Fundo: quadrado arredondado em gradiente vertical azul institucional
      (#1351B4 -> #0C326F, paleta gov.br/CNJ).
    - Glifo "p" estilizado em branco:
        * haste vertical solida do lado esquerdo
        * "bocal" representado por um anel (circulo aberto) ligado a haste
    - No centro do anel, um nucleo amarelo (#FFCD07) — o "spark" de IA, que
      faz o olho ler o glifo simultaneamente como letra "p" e como nó/grafo
      de inteligencia, ressaltando o "AI" do nome.

Rode a partir da raiz do projeto (Node nao e necessario aqui):
    python tools\\gen_icons.py
"""

from __future__ import annotations

import os
import struct
import zlib

# Paleta institucional gov.br / CNJ
BLUE_TOP = (19, 81, 180, 255)   # #1351B4
BLUE_BOT = (12, 50, 111, 255)   # #0C326F
WHITE = (255, 255, 255, 255)
YELLOW = (255, 205, 7, 255)     # #FFCD07
TRANSPARENT = (0, 0, 0, 0)


def rounded_rect_contains(
    x: int, y: int, x0: int, y0: int, x1: int, y1: int, r: int
) -> bool:
    """Retorna True se (x, y) esta dentro de um retangulo arredondado."""
    if x < x0 or x >= x1 or y < y0 or y >= y1:
        return False
    cx: int | None = None
    cy: int | None = None
    if x < x0 + r and y < y0 + r:
        cx, cy = x0 + r, y0 + r
    elif x >= x1 - r and y < y0 + r:
        cx, cy = x1 - r - 1, y0 + r
    elif x < x0 + r and y >= y1 - r:
        cx, cy = x0 + r, y1 - r - 1
    elif x >= x1 - r and y >= y1 - r:
        cx, cy = x1 - r - 1, y1 - r - 1
    if cx is None or cy is None:
        return True
    dx = x - cx
    dy = y - cy
    return dx * dx + dy * dy <= r * r


def lerp_color(
    c1: tuple[int, int, int, int],
    c2: tuple[int, int, int, int],
    t: float,
) -> tuple[int, int, int, int]:
    """Interpolacao linear entre duas cores RGBA (t ∈ [0,1])."""
    if t < 0.0:
        t = 0.0
    elif t > 1.0:
        t = 1.0
    return (
        int(c1[0] + (c2[0] - c1[0]) * t),
        int(c1[1] + (c2[1] - c1[1]) * t),
        int(c1[2] + (c2[2] - c1[2]) * t),
        255,
    )


def render(size: int) -> list[bytes]:
    s = size

    # Quadrado arredondado de fundo, ocupando toda a area.
    bg_r = max(2, int(s * 0.22))

    # Coordenadas normalizadas (0..1) do glifo "p", convertidas para pixels.
    # Haste vertical do "p"
    stem_x0 = s * 0.275
    stem_x1 = s * 0.395
    stem_y0 = s * 0.170
    stem_y1 = s * 0.880

    # Anel (bocal do "p")
    bowl_cx = s * 0.595
    bowl_cy = s * 0.430
    bowl_r_outer = s * 0.245
    bowl_r_inner = s * 0.140

    # Nucleo amarelo de IA dentro do anel
    dot_r = s * 0.085

    # Pre-calcula quadrados para evitar sqrt
    bowl_ro2 = bowl_r_outer * bowl_r_outer
    bowl_ri2 = bowl_r_inner * bowl_r_inner
    dot_r2 = dot_r * dot_r

    rows: list[bytes] = []
    for y in range(s):
        row = bytearray()
        # Gradiente vertical: cor varia com a linha y
        t_grad = y / max(1, s - 1)
        bg_color = lerp_color(BLUE_TOP, BLUE_BOT, t_grad)
        for x in range(s):
            pixel = TRANSPARENT

            if rounded_rect_contains(x, y, 0, 0, s, s, bg_r):
                pixel = bg_color

                # Haste do "p" (branco)
                if stem_x0 <= x < stem_x1 and stem_y0 <= y < stem_y1:
                    pixel = WHITE

                # Anel + nucleo de IA
                dx = x - bowl_cx
                dy = y - bowl_cy
                dist2 = dx * dx + dy * dy
                if dist2 <= bowl_ro2:
                    if dist2 >= bowl_ri2:
                        pixel = WHITE
                    if dist2 <= dot_r2:
                        pixel = YELLOW

            row.extend(pixel)
        rows.append(bytes(row))
    return rows


def write_png(path: str, size: int) -> None:
    rows = render(size)

    def chunk(tag: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

    sig = b"\x89PNG\r\n\x1a\n"
    # 8 bits por canal, RGBA (color type = 6)
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    raw = b"".join(b"\x00" + r for r in rows)  # filter byte 0 por linha
    idat = zlib.compress(raw, 9)

    with open(path, "wb") as f:
        f.write(sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b""))


def main() -> None:
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")
    out_dir = os.path.normpath(out_dir)
    os.makedirs(out_dir, exist_ok=True)

    for size in (16, 32, 48, 128):
        path = os.path.join(out_dir, f"icon{size}.png")
        write_png(path, size)
        print(f"[pAIdegua] gerado {path} ({size}x{size})")

    print("[pAIdegua] icones gerados com sucesso.")


if __name__ == "__main__":
    main()