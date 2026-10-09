"""licenses.py - Texas trade-licence rosters as a free lead source.

Licensed plumbing and electrical businesses in Texas are published by the
state with a phone number. No scraping, no Google, no home IP needed:

    plumber      TSBPE "Responsible Master Plumber" CSV (one per plumbing company)
                 https://tsbpe.texas.gov/free-licensee-list/
    electrician  TDLR "Electrical Contractor", data.texas.gov dataset 7358-krk7
                 (Socrata API, updated weekly)

A/C contractors are in the same TDLR dataset but without phone or address,
so they are not offered.

Rows are filtered to current licences with a phone, de-duplicated on phone,
and cached for a day. The rosters do NOT say whether a business has a
website; run web_presence (and optionally a Maps check) on each lead.
"""
from __future__ import annotations

import csv
import io
import json
import re
import time
import urllib.parse
import urllib.request
from datetime import date, datetime
from typing import Optional

TSBPE_RMP_CSV = "https://tsbpe.texas.gov/download-csv/RMP/"
TDLR_API = "https://data.texas.gov/resource/7358-krk7.json"
TDLR_TYPES = {"electrician": "Electrical Contractor"}
TRADES = ("plumber", *TDLR_TYPES)
DFW_COUNTIES = ("DALLAS", "TARRANT", "COLLIN", "DENTON")
_COUNTY_RE = re.compile(r"[A-Z][A-Z .-]{1,24}")  # no quotes: values go into a SoQL literal
_CACHE_S = 24 * 3600
_MAX_LIMIT = 200
_cache: dict[tuple, tuple[float, list[dict]]] = {}


def _phone(*vals: Optional[str]) -> Optional[str]:
    for v in vals:
        d = re.sub(r"\D", "", v or "")[-10:]
        if len(d) == 10:
            return d
    return None


def _expires(s: Optional[str]) -> Optional[date]:
    try:
        return datetime.strptime((s or "").strip(), "%m/%d/%Y").date()
    except ValueError:
        return None


def _dedupe(rows: list[dict]) -> list[dict]:
    seen, out = set(), []
    for r in rows:
        if r["phone"] not in seen:
            seen.add(r["phone"])
            out.append(r)
    return out


def parse_tsbpe(text: str, counties: set[str], today: date) -> list[dict]:
    """Pure: TSBPE RMP CSV text -> lead rows (current, has phone, in counties)."""
    rows = []
    for x in csv.DictReader(io.StringIO(text.lstrip("﻿"))):
        exp = _expires(x.get("EXPIRATION_DTE"))
        phone = _phone(x.get("PHONE"))
        if x.get("LIC_STATUS") != "Current" or not phone or (exp and exp < today):
            continue
        if (x.get("COUNTY") or "").upper() not in counties:
            continue
        owner = " ".join(p for p in (x.get("FIRST_NAME"), x.get("LAST_NAME")) if p).title()
        rows.append({
            "source": "tsbpe", "trade": "plumber", "license_number": x.get("LICENSE_NBR"),
            "business_name": (x.get("PLUMB_COMPANY") or "").strip() or owner,
            "owner_name": owner, "phone": phone,
            "address": (x.get("ADDR1") or "").strip() or None, "city": (x.get("CITY") or "").title() or None,
            "zip": (x.get("ZIP") or "")[:5] or None, "county": x["COUNTY"].upper(),
            "lat": None, "lng": None, "license_expires": exp.isoformat() if exp else None,
        })
    return _dedupe(rows)


def parse_tdlr(items: list[dict], trade: str, today: date) -> list[dict]:
    """Pure: TDLR Socrata rows -> lead rows (current, has phone)."""
    rows = []
    for x in items:
        exp = _expires(x.get("license_expiration_date_mmddccyy"))
        phone = _phone(x.get("business_telephone"), x.get("owner_telephone"))
        if not phone or not exp or exp < today:
            continue
        m = re.match(r"(.*?)\s+[A-Z]{2}\s+(\d{5})", x.get("business_city_state_zip") or "")
        pt = (x.get("business_mailing") or {}).get("coordinates") or [None, None]
        rows.append({
            "source": "tdlr", "trade": trade, "license_number": x.get("license_number"),
            "business_name": (x.get("business_name") or "").strip(),
            "owner_name": (x.get("owner_name") or "").strip() or None, "phone": phone,
            "address": (x.get("business_address_line1") or "").strip() or None,
            "city": m.group(1).title() if m else None, "zip": m.group(2) if m else None,
            "county": (x.get("business_county") or "").upper() or None,
            "lat": pt[1], "lng": pt[0], "license_expires": exp.isoformat(),
        })
    return _dedupe(rows)


def _get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "maps-harvest/1 (licence roster fetch)"})
    with urllib.request.urlopen(req, timeout=60) as r:  # noqa: S310 - fixed https URLs above
        return r.read()


def _load(trade: str, counties: tuple[str, ...]) -> list[dict]:
    key = (trade, counties)
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < _CACHE_S:
        return hit[1]
    today = date.today()
    if trade == "plumber":
        rows = parse_tsbpe(_get(TSBPE_RMP_CSV).decode("utf-8", "replace"), set(counties), today)
    else:
        # counties are validated against _COUNTY_RE before they reach this SoQL string.
        quoted = ",".join(f"'{c}'" for c in counties)  # separate line: Python 3.11 (Railway) can't nest the quotes
        where = f"license_type='{TDLR_TYPES[trade]}' AND business_county in({quoted})"
        q = urllib.parse.urlencode({"$where": where, "$limit": 50000, "$order": "license_number"})
        rows = parse_tdlr(json.loads(_get(f"{TDLR_API}?{q}")), trade, today)
    _cache[key] = (time.monotonic(), rows)
    return rows


def license_leads(trade: str, counties: Optional[str] = None, offset: int = 0, limit: int = 100) -> dict:
    trade = (trade or "").strip().lower()
    if trade not in TRADES:
        return {"error": "invalid_argument", "reason": f"trade must be one of {', '.join(TRADES)}"}
    names = tuple(sorted({c.strip().upper() for c in (counties or ",".join(DFW_COUNTIES)).split(",") if c.strip()}))
    if not names or not all(_COUNTY_RE.fullmatch(c) for c in names):
        return {"error": "invalid_argument", "reason": "counties must be comma-separated Texas county names"}
    offset, limit = max(0, int(offset)), max(1, min(int(limit), _MAX_LIMIT))
    try:
        rows = _load(trade, names)
    except Exception as exc:  # noqa: BLE001 - network/source failure is a value, not a crash
        return {"error": "source_unavailable", "reason": type(exc).__name__}
    page = rows[offset:offset + limit]
    return {
        "trade": trade, "counties": list(names), "total": len(rows), "offset": offset,
        "next_offset": offset + len(page) if offset + len(page) < len(rows) else None,
        "results": page,
    }
