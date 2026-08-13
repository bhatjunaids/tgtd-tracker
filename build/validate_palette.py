#!/usr/bin/env python3
"""Port of the dataviz skill's six-check categorical palette validator.

Node isn't available on this machine, so the checks are reimplemented here:
OKLCH lightness band, chroma floor, CVD separation (Machado-Oliveira-Fernandes
2009 at severity 1.0, OKLab dE x100), normal-vision floor, and surface contrast.
"""

import itertools
import math
import sys

# Machado et al. 2009, severity 1.0, applied to LINEAR RGB.
CVD = {
    "protanopia": (
        (0.152286, 1.052583, -0.204868),
        (0.114503, 0.786281, 0.099216),
        (-0.003882, -0.048116, 1.051998),
    ),
    "deuteranopia": (
        (0.367322, 0.860646, -0.227968),
        (0.280085, 0.672501, 0.047413),
        (-0.011820, 0.042940, 0.968881),
    ),
}


def hex2rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def srgb2lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def lin2srgb(c):
    c = max(0.0, min(1.0, c))
    return c * 12.92 if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055


def lin_rgb(h):
    return tuple(srgb2lin(c) for c in hex2rgb(h))


def oklab(lin):
    r, g, b = lin
    l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
    m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
    s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
    l_, m_, s_ = (v ** (1 / 3) if v > 0 else -((-v) ** (1 / 3)) for v in (l, m, s))
    return (
        0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
        1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
        0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
    )


def oklch(h):
    L, a, b = oklab(lin_rgb(h))
    return L, math.hypot(a, b), math.degrees(math.atan2(b, a)) % 360


def simulate(h, kind):
    m = CVD[kind]
    r, g, b = lin_rgb(h)
    out = [sum(row[i] * v for i, v in enumerate((r, g, b))) for row in m]
    return oklab(tuple(srgb2lin(lin2srgb(c)) for c in out))


def de(p, q):
    return math.dist(p, q) * 100


def luminance(h):
    r, g, b = lin_rgb(h)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    la, lb = luminance(a), luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def check(palette, mode="light", surface="#fcfcfb", pairs="all"):
    band = (0.43, 0.77) if mode == "light" else (0.48, 0.67)
    print(f"\n=== mode {mode} · surface {surface} · pairs {pairs} ===")
    fails = 0

    print(f"{'hex':<10}{'L':>7}{'C':>7}{'band':>8}{'chroma':>8}{'contrast':>10}{'':>6}")
    for h in palette:
        L, C, _ = oklch(h)
        cr = contrast(h, surface)
        b_ok = band[0] <= L <= band[1]
        c_ok = C >= 0.10
        cr_flag = "PASS" if cr >= 3 else "WARN"
        if not b_ok or not c_ok:
            fails += 1
        print(f"{h:<10}{L:>7.3f}{C:>7.3f}{'PASS' if b_ok else 'FAIL':>8}"
              f"{'PASS' if c_ok else 'FAIL':>8}{cr:>10.2f}{cr_flag:>6}")

    idx = list(itertools.combinations(range(len(palette)), 2)) if pairs == "all" \
        else [(i, i + 1) for i in range(len(palette) - 1)]

    worst_norm = (1e9, None)
    worst_cvd = (1e9, None, None)
    for i, j in idx:
        a, b = palette[i], palette[j]
        d = de(oklab(lin_rgb(a)), oklab(lin_rgb(b)))
        if d < worst_norm[0]:
            worst_norm = (d, f"{a}/{b}")
        for kind in CVD:
            dc = de(simulate(a, kind), simulate(b, kind))
            if dc < worst_cvd[0]:
                worst_cvd = (dc, f"{a}/{b}", kind)

    nv = "PASS" if worst_norm[0] >= 15 else "FAIL"
    cv = "PASS" if worst_cvd[0] >= 8 else ("WARN" if worst_cvd[0] >= 6 else "FAIL")
    if nv == "FAIL":
        fails += 1
    if cv == "FAIL":
        fails += 1
    print(f"normal-vision worst pair : {worst_norm[0]:6.1f}  {worst_norm[1]}   [{nv}] (floor 15)")
    print(f"CVD worst pair           : {worst_cvd[0]:6.1f}  {worst_cvd[1]} ({worst_cvd[2]})   [{cv}] (target 8)")
    return fails


if __name__ == "__main__":
    pal = sys.argv[1].split(",")
    n = check(pal, "light", "#FFFFFF")
    n += check(pal, "dark", "#161A20")
    print("\nRESULT:", "FAIL" if n else "OK")
    sys.exit(1 if n else 0)
