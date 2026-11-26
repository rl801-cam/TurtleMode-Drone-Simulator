#!/usr/bin/env python3
"""Encode images to DDS with a full mip chain: DXT1 (BC1) for opaque images, DXT5 (BC3) where
the alpha channel is used. GPU block compression cuts texture memory 4-8x (1024^2 RGBA with
mips: 5.6 MB -> 0.7 MB as DXT1) and the bandwidth the GPU spends sampling, which is what an
integrated GPU sharing system RAM is short of.

    dds_encode.py OUT_DIR IMG [IMG ...]      -> OUT_DIR/<stem>.dds per image

Encoder: per 4x4 block, endpoints from the block's principal axis (PCA) extent, then each pixel
to the nearest palette entry; alpha endpoints from min/max with the 8-level mode. Numpy, block-
vectorised. Mips are box-filtered in linear light for sRGB colour images (--linear for data maps).
"""

import argparse
import os
import struct

import numpy as np
from PIL import Image


def srgb_to_lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(np.maximum(c, 0), 1 / 2.4) - 0.055)


def mip_chain(img, srgb):
    """img: HxWx4 float 0..1. Returns list of levels down to 1x1 (box filter)."""
    levels = [img]
    while max(levels[-1].shape[:2]) > 1:
        a = levels[-1]
        h, w = a.shape[:2]
        h2, w2 = max(1, h // 2), max(1, w // 2)
        if srgb:
            rgb = srgb_to_lin(a[..., :3])
            a = np.concatenate([rgb, a[..., 3:]], -1)
        a = a[: h2 * (h // h2), : w2 * (w // w2)].reshape(h2, h // h2, w2, w // w2, 4).mean((1, 3))
        if srgb:
            a = np.concatenate([lin_to_srgb(a[..., :3]), a[..., 3:]], -1)
        levels.append(np.clip(a, 0, 1))
    return levels


def to_blocks(a):
    """HxWxC -> (N,16,C), padding to a multiple of 4 by edge repeat."""
    h, w, c = a.shape
    H, W = (h + 3) // 4 * 4, (w + 3) // 4 * 4
    if (h, w) != (H, W):
        a = np.pad(a, ((0, H - h), (0, W - w), (0, 0)), mode='edge')
    return a.reshape(H // 4, 4, W // 4, 4, c).transpose(0, 2, 1, 3, 4).reshape(-1, 16, c)


def q565(c):
    """c (N,3) float 0..1 -> uint16 565 and its decoded float."""
    r = np.round(c[:, 0] * 31).astype(np.int32)
    g = np.round(c[:, 1] * 63).astype(np.int32)
    b = np.round(c[:, 2] * 31).astype(np.int32)
    r, g, b = np.clip(r, 0, 31), np.clip(g, 0, 63), np.clip(b, 0, 31)
    v = (r << 11) | (g << 5) | b
    dec = np.stack([r / 31, g / 63, b / 31], 1)
    return v.astype(np.uint16), dec


def encode_color(rgb):
    """rgb (N,16,3) -> (N,8) bytes of BC1 colour data (4-colour mode)."""
    n = rgb.shape[0]
    mean = rgb.mean(1, keepdims=True)
    d = rgb - mean
    cov = np.einsum('npi,npj->nij', d, d)
    axis = np.ones((n, 3)) / np.sqrt(3)
    for _ in range(8):  # power iteration
        axis = np.einsum('nij,nj->ni', cov, axis)
        axis /= np.linalg.norm(axis, axis=1, keepdims=True) + 1e-12
    t = np.einsum('npi,ni->np', d, axis)
    lo = mean[:, 0] + axis * t.min(1, keepdims=True)
    hi = mean[:, 0] + axis * t.max(1, keepdims=True)
    v0, c0 = q565(np.clip(hi, 0, 1))
    v1, c1 = q565(np.clip(lo, 0, 1))
    # 4-colour mode needs v0 > v1; swap where needed, and nudge equal endpoints apart.
    sw = v0 < v1
    v0, v1 = np.where(sw, v1, v0), np.where(sw, v0, v1)
    c0, c1 = np.where(sw[:, None], c1, c0), np.where(sw[:, None], c0, c1)
    eq = v0 == v1
    v0 = np.where(eq & (v0 < 0xFFFF), v0 + 1, v0)
    v1 = np.where(eq & (v0 == 0xFFFF), v1 - 1, v1)
    pal = np.stack([c0, c1, (2 * c0 + c1) / 3, (c0 + 2 * c1) / 3], 1)  # (N,4,3)
    dist = ((rgb[:, :, None, :] - pal[:, None, :, :]) ** 2).sum(-1)  # (N,16,4)
    idx = dist.argmin(-1).astype(np.uint32)
    bits = np.zeros(n, np.uint32)
    for p in range(16):
        bits |= idx[:, p] << (2 * p)
    out = np.zeros((n, 8), np.uint8)
    out[:, 0:2] = v0.astype(np.uint16).view(np.uint8).reshape(n, 2)
    out[:, 2:4] = v1.astype(np.uint16).view(np.uint8).reshape(n, 2)
    out[:, 4:8] = bits.view(np.uint8).reshape(n, 4)
    return out


def encode_alpha(a):
    """a (N,16) -> (N,8) bytes of BC3 alpha data (8-level mode)."""
    n = a.shape[0]
    a0 = np.round(a.max(1) * 255).astype(np.int32)
    a1 = np.round(a.min(1) * 255).astype(np.int32)
    # a0 == a1 (flat block) selects the 6-level mode, where index 0 is still a0: fine.
    lv = [a0, a1] + [((7 - k) * a0 + k * a1) / 7 for k in range(1, 7)]
    pal = np.stack(lv, 1) / 255  # (N,8)
    idx = np.abs(a[:, :, None] - pal[:, None, :]).argmin(-1).astype(np.uint64)
    bits = np.zeros(n, np.uint64)
    for p in range(16):
        bits |= idx[:, p] << np.uint64(3 * p)
    out = np.zeros((n, 8), np.uint8)
    out[:, 0] = a0
    out[:, 1] = a1
    out[:, 2:8] = bits.view(np.uint8).reshape(n, 8)[:, :6]
    return out


def dds_header(w, h, mips, fourcc, linear_size):
    DDSD = 0x1 | 0x2 | 0x4 | 0x1000 | 0x20000 | 0x80000
    hdr = struct.pack('<4sIIIIIII44x', b'DDS ', 124, DDSD, h, w, linear_size, 0, mips)
    pf = struct.pack('<II4sIIIII', 32, 0x4, fourcc, 0, 0, 0, 0, 0)
    caps = struct.pack('<IIII4x', 0x1000 | 0x400000 | 0x8, 0, 0, 0)
    return hdr + pf + caps


def encode_file(src, out_dir, linear=False):
    im = Image.open(src).convert('RGBA')
    a = np.asarray(im, np.float32) / 255
    has_alpha = (a[..., 3] < 0.99).any()
    levels = mip_chain(a, srgb=not linear)
    data = []
    for lv in levels:
        b = to_blocks(lv)
        col = encode_color(b[..., :3])
        data.append(
            np.concatenate([encode_alpha(b[..., 3]), col], 1).tobytes()
            if has_alpha
            else col.tobytes()
        )
    h, w = a.shape[:2]
    out = os.path.join(out_dir, os.path.splitext(os.path.basename(src))[0] + '.dds')
    with open(out, 'wb') as f:
        f.write(dds_header(w, h, len(levels), b'DXT5' if has_alpha else b'DXT1', len(data[0])))
        for d in data:
            f.write(d)
    return out, has_alpha, os.path.getsize(out)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('out_dir')
    ap.add_argument('images', nargs='+')
    ap.add_argument(
        '--linear', nargs='*', default=[], help='basenames to filter in linear space (data maps)'
    )
    args = ap.parse_args()
    os.makedirs(args.out_dir, exist_ok=True)
    lin = set(args.linear)
    for p in args.images:
        o, al, sz = encode_file(p, args.out_dir, linear=os.path.basename(p) in lin)
        print(os.path.basename(o), 'DXT5' if al else 'DXT1', sz)
