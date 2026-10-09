"""tiles.py - viewport tiling and Google Maps URL construction.

Pure functions, no I/O. A *tile* is a map viewport described by its centre
(lat, lng) and a Google Maps zoom level. Google Maps caps a search feed at
roughly 120 results, so any tile that returns `saturated: true` from
`harvest_tile` must be split into four children at zoom+1 and searched again.
`AdaptiveTiler` implements that queue; the MCP server also exposes the
subdivision math as tools so an agent never has to do it by hand.
"""
from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass
from typing import Iterator
from urllib.parse import quote

# The pixel size of the browser viewport the harvester runs at. The visible
# lat/lng span of a tile depends on it, so keep this in sync with the
# viewport configured in maps_harvest.py.
VIEWPORT_W = 1280
VIEWPORT_H = 900

MIN_ZOOM = 3
MAX_ZOOM = 21

# Dallas-Fort Worth metro bounding box (south, west, north, east).
DFW_BBOX = (32.55, -97.55, 33.25, -96.45)


def maps_url(category: str, lat: float, lng: float, zoom: int) -> str:
    """Build a Google Maps search URL for `category` centred on a viewport.

    `hl=en` pins the UI language so text-based selectors (e.g. "Website",
    "Permanently closed") are stable regardless of the machine's locale.
    """
    cat = quote(category.strip())
    return f"https://www.google.com/maps/search/{cat}/@{lat:.6f},{lng:.6f},{int(zoom)}z?hl=en"


def degrees_per_pixel(lat: float, zoom: int) -> tuple[float, float]:
    """(lat_deg_per_px, lng_deg_per_px) for a Web Mercator map at `zoom`."""
    lng_dpp = 360.0 / (256.0 * (2 ** zoom))
    lat_dpp = lng_dpp * math.cos(math.radians(lat))
    return lat_dpp, lng_dpp


@dataclass(frozen=True)
class Tile:
    lat: float
    lng: float
    zoom: int

    def span(self) -> tuple[float, float]:
        """(lat_span, lng_span) in degrees visible in the viewport."""
        lat_dpp, lng_dpp = degrees_per_pixel(self.lat, self.zoom)
        return lat_dpp * VIEWPORT_H, lng_dpp * VIEWPORT_W

    def bounds(self) -> tuple[float, float, float, float]:
        """(south, west, north, east)."""
        lat_span, lng_span = self.span()
        return (
            self.lat - lat_span / 2,
            self.lng - lng_span / 2,
            self.lat + lat_span / 2,
            self.lng + lng_span / 2,
        )

    def subdivide(self) -> list["Tile"]:
        """Four children at zoom+1 whose viewports together cover this tile."""
        if self.zoom >= MAX_ZOOM:
            return []
        lat_span, lng_span = self.span()
        z = self.zoom + 1
        return [
            Tile(round(self.lat + dy * lat_span / 4, 6), round(self.lng + dx * lng_span / 4, 6), z)
            for dy in (1, -1)
            for dx in (-1, 1)
        ]

    def url(self, category: str) -> str:
        return maps_url(category, self.lat, self.lng, self.zoom)

    def as_dict(self) -> dict:
        s, w, n, e = self.bounds()
        return {
            "lat": self.lat,
            "lng": self.lng,
            "zoom": self.zoom,
            "bounds": {"south": round(s, 6), "west": round(w, 6), "north": round(n, 6), "east": round(e, 6)},
        }


def grid(south: float, west: float, north: float, east: float, zoom: int, overlap: float = 0.1) -> Iterator[Tile]:
    """Yield tiles at `zoom` covering a bounding box, overlapping by `overlap`.

    Overlap (fraction of a tile) guards against businesses that sit on a
    tile boundary being missed; the caller de-duplicates on `maps_cid`.
    """
    if not (MIN_ZOOM <= zoom <= MAX_ZOOM):
        raise ValueError(f"zoom must be between {MIN_ZOOM} and {MAX_ZOOM}")
    if south >= north or west >= east:
        raise ValueError("bbox must satisfy south < north and west < east")
    mid_lat = (south + north) / 2
    lat_dpp, lng_dpp = degrees_per_pixel(mid_lat, zoom)
    lat_step = lat_dpp * VIEWPORT_H * (1 - overlap)
    lng_step = lng_dpp * VIEWPORT_W * (1 - overlap)
    lat = south + lat_step / 2
    while lat - lat_step / 2 < north:
        lng = west + lng_step / 2
        while lng - lng_step / 2 < east:
            yield Tile(round(lat, 6), round(lng, 6), zoom)
            lng += lng_step
        lat += lat_step


class AdaptiveTiler:
    """Work queue that subdivides saturated tiles.

    >>> tiler = AdaptiveTiler(grid(*DFW_BBOX, zoom=13))
    >>> while (tile := tiler.next()) is not None:
    ...     result = harvest(tile)            # your harvest_tile call
    ...     tiler.report(tile, result["saturated"])
    """

    def __init__(self, tiles, max_zoom: int = 17):
        self.pending: deque[Tile] = deque(tiles)
        self.done: list[Tile] = []
        self.max_zoom = max_zoom

    def next(self) -> Tile | None:
        return self.pending.popleft() if self.pending else None

    def report(self, tile: Tile, saturated: bool) -> None:
        self.done.append(tile)
        if saturated and tile.zoom < self.max_zoom:
            self.pending.extend(tile.subdivide())

    def __len__(self) -> int:
        return len(self.pending)
