#!/usr/bin/env python3
"""Normalize generated avatar PNGs and trace their dark line art into SVG paths."""

from __future__ import annotations

from collections import defaultdict
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parent
SOURCE_DIR = ROOT / "source"
SIZE = 1024
CENTER = SIZE // 2
RADIUS = 500
BLACK_THRESHOLD = 122
SIMPLIFY_TOLERANCE = 1.35


def normalize_png(source: Path, destination: Path) -> Image.Image:
    image = Image.open(source).convert("RGBA").resize((SIZE, SIZE), Image.Resampling.LANCZOS)
    circle_mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(circle_mask).ellipse(
        (CENTER - RADIUS, CENTER - RADIUS, CENTER + RADIUS, CENTER + RADIUS),
        fill=255,
    )
    alpha = Image.fromarray(
        np.minimum(np.asarray(image.getchannel("A")), np.asarray(circle_mask)).astype(np.uint8),
        mode="L",
    )
    image.putalpha(alpha)
    image.save(destination, optimize=True)
    return image


def boundary_edges(mask: np.ndarray) -> list[tuple[tuple[int, int], tuple[int, int]]]:
    height, width = mask.shape
    ys, xs = np.nonzero(mask)
    edges: list[tuple[tuple[int, int], tuple[int, int]]] = []
    for y, x in zip(ys.tolist(), xs.tolist()):
        if y == 0 or not mask[y - 1, x]:
            edges.append(((x, y), (x + 1, y)))
        if x == width - 1 or not mask[y, x + 1]:
            edges.append(((x + 1, y), (x + 1, y + 1)))
        if y == height - 1 or not mask[y + 1, x]:
            edges.append(((x + 1, y + 1), (x, y + 1)))
        if x == 0 or not mask[y, x - 1]:
            edges.append(((x, y + 1), (x, y)))
    return edges


def direction(start: tuple[int, int], end: tuple[int, int]) -> int:
    dx, dy = end[0] - start[0], end[1] - start[1]
    return {(1, 0): 0, (0, 1): 1, (-1, 0): 2, (0, -1): 3}[(dx, dy)]


def trace_loops(edges: list[tuple[tuple[int, int], tuple[int, int]]]) -> list[list[tuple[int, int]]]:
    outgoing: dict[tuple[int, int], list[tuple[int, int]]] = defaultdict(list)
    unused = set(edges)
    for start, end in edges:
        outgoing[start].append(end)

    loops: list[list[tuple[int, int]]] = []
    while unused:
        start_edge = next(iter(unused))
        start, current = start_edge
        previous = start
        unused.remove(start_edge)
        points = [start, current]

        while current != start:
            candidates = [end for end in outgoing[current] if (current, end) in unused]
            if not candidates:
                break
            incoming = direction(previous, current)
            ranked = sorted(
                candidates,
                key=lambda end: {1: 0, 0: 1, 3: 2, 2: 3}[
                    (direction(current, end) - incoming) % 4
                ],
            )
            next_point = ranked[0]
            unused.remove((current, next_point))
            previous, current = current, next_point
            points.append(current)

        if len(points) >= 5 and points[-1] == start:
            loops.append(points[:-1])
    return loops


def perpendicular_distance(point, start, end) -> float:
    px, py = point
    sx, sy = start
    ex, ey = end
    dx, dy = ex - sx, ey - sy
    if dx == 0 and dy == 0:
        return float(((px - sx) ** 2 + (py - sy) ** 2) ** 0.5)
    return abs(dy * px - dx * py + ex * sy - ey * sx) / float((dx * dx + dy * dy) ** 0.5)


def rdp(points: list[tuple[int, int]], tolerance: float) -> list[tuple[int, int]]:
    if len(points) <= 2:
        return points
    start, end = points[0], points[-1]
    max_distance = -1.0
    index = 0
    for i, point in enumerate(points[1:-1], start=1):
        distance = perpendicular_distance(point, start, end)
        if distance > max_distance:
            index, max_distance = i, distance
    if max_distance > tolerance:
        left = rdp(points[: index + 1], tolerance)
        right = rdp(points[index:], tolerance)
        return left[:-1] + right
    return [start, end]


def simplify_loop(points: list[tuple[int, int]]) -> list[tuple[int, int]]:
    if len(points) < 4:
        return points
    anchor = min(range(len(points)), key=lambda index: points[index])
    rotated = points[anchor:] + points[:anchor]
    simplified = rdp(rotated + [rotated[0]], SIMPLIFY_TOLERANCE)
    return simplified[:-1] if simplified[-1] == simplified[0] else simplified


def trace_svg(image: Image.Image, destination: Path) -> None:
    rgba = np.asarray(image)
    rgb = rgba[:, :, :3].astype(np.float32)
    luminance = rgb[:, :, 0] * 0.2126 + rgb[:, :, 1] * 0.7152 + rgb[:, :, 2] * 0.0722
    mask = (rgba[:, :, 3] > 0) & (luminance < BLACK_THRESHOLD)
    loops = [simplify_loop(loop) for loop in trace_loops(boundary_edges(mask))]
    loops = [loop for loop in loops if len(loop) >= 3]

    path_parts: list[str] = []
    for loop in loops:
        commands = [f"M{loop[0][0]} {loop[0][1]}"]
        commands.extend(f"L{x} {y}" for x, y in loop[1:])
        commands.append("Z")
        path_parts.append(" ".join(commands))

    clip_id = f"{destination.stem}-avatar-clip"
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" '
        'role="img" aria-hidden="true">\n'
        '  <circle cx="512" cy="512" r="500" fill="#f7f8fa" stroke="#d5dbe1" stroke-width="4"/>\n'
        f'  <path d="{" ".join(path_parts)}" fill="#111111" fill-rule="evenodd" clip-path="url(#{clip_id})"/>\n'
        f'  <defs><clipPath id="{clip_id}"><circle cx="512" cy="512" r="498"/></clipPath></defs>\n'
        '</svg>\n'
    )
    destination.write_text(svg, encoding="utf-8")


def main() -> None:
    for source in sorted(SOURCE_DIR.glob("*.png")):
        normalized = normalize_png(source, ROOT / source.name)
        trace_svg(normalized, ROOT / f"{source.stem}.svg")


if __name__ == "__main__":
    main()
