"""maps_harvest.py - Google Maps card-feed harvester on Camoufox.

Everything that touches a web page lives here. Callers (the MCP server in
server.py) only ever receive small JSON-serialisable dicts: either a result
record or an enumerated error such as {"error": "challenge_detected"}. No
HTML, no accessibility tree, no page text ever leaves this module.

Failure modes are enumerated return values, not exceptions:

    challenge_detected   bot wall / CAPTCHA. A cooldown starts; further calls
                         return the same error until it expires.
    selectors_stale      the feed / detail panel never rendered. Google has
                         probably changed the DOM; repair SELECTORS and bump
                         SELECTOR_VERSION.
    timeout              per-call wall clock exceeded (default 60 s).
    circuit_open         too many consecutive empty harvests (likely blocked
                         or stale selectors); restart the process to reset.
    budget_exhausted     per-process call budget used up.
    invalid_argument     bad lat/lng/zoom/url.
    internal             unexpected exception (class name only, no page data).

Selector maintenance: everything that depends on Google's DOM is in the
SELECTORS dict below. Change only that dict and SELECTOR_VERSION; every tool
response carries `selector_version` so rows harvested under a broken
selector set can be identified and re-queued.
"""
from __future__ import annotations

import asyncio
import functools
import html
import ipaddress
import json
import logging
import os
import random
import re
import socket
import time
import urllib.error
import urllib.request
from datetime import date, timedelta
from typing import Any, Optional
from urllib.parse import parse_qs, quote_plus, unquote, urlparse

import tiles

log = logging.getLogger("maps_harvest")

# ---------------------------------------------------------------------------
# Selectors - the ONLY place Google's DOM is referenced.
# ---------------------------------------------------------------------------
SELECTOR_VERSION = "2026-09-13.1"

SELECTORS: dict[str, str] = {
    # -- search results feed (harvest_tile) ---------------------------------
    "feed": 'div[role="feed"]',
    "card": "div.Nv2PK",
    "card_link": 'a[href*="/maps/place/"]',
    "card_rating": 'span[role="img"][aria-label*="star" i]',
    "card_website": 'a[data-value="Website"]',
    "card_meta_row": "div.W4Efsd",
    "end_of_list_text": r"reached the end of the list",
    "no_results_text": r"can't find|couldn't find|no results found|did not match",
    # -- interstitials --------------------------------------------------------
    "consent_host": "consent.google.com",
    "consent_button": (
        'button[aria-label*="Reject all" i], button[aria-label*="Accept all" i], '
        'form[action*="consent"] button'
    ),
    "challenge_url": r"/sorry/|recaptcha",
    "challenge_dom": 'form#captcha-form, iframe[src*="recaptcha"], div#recaptcha, div.g-recaptcha',
    "challenge_text": r"unusual traffic|not a robot|verify you are human|automated queries",
    # -- place detail panel (listing_detail / check_operating) ---------------
    "detail_main": 'div[role="main"]',
    "detail_title": 'div[role="main"] h1',
    "detail_website": 'a[data-item-id="authority"]',
    "detail_phone": 'button[data-item-id^="phone:tel:"]',
    "detail_address": 'button[data-item-id="address"]',
    "detail_category": 'button[jsaction*="category"]',
    "detail_hours_button": 'button[data-item-id="oh"]',
    "detail_hours_row": "table.eK4R0e tr",
    "detail_rating": 'div.F7nice span[aria-hidden="true"]',
    "detail_review_count": 'div.F7nice span[aria-label$=" reviews"], div.F7nice span[aria-label$=" review"]',
    "detail_claim": 'a[data-item-id="merchant"], a[href*="/business/claim"], a[href*="business.google.com"]',
    "detail_claim_text": r"claim this business|own this business",
    "detail_closed_text": r"permanently closed",
    "detail_temp_closed_text": r"temporarily closed",
    # -- reviews (check_operating) -------------------------------------------
    "reviews_tab": 'button[role="tab"][aria-label*="Reviews" i]',
    "reviews_sort_button": 'button[aria-label="Sort reviews"], button[data-value="Sort"]',
    "reviews_sort_newest": 'div[role="menu"] [role="menuitemradio"]:nth-of-type(2), div[role="menu"] div[data-index="1"]',
    "review_item": "div[data-review-id]",
    "review_date": "span.rsqaWe",
    "review_owner_response_text": r"response from the owner",
    # -- web search (web_presence); DuckDuckGo's no-JS results page ----------
    "search_result": "div.result:not(.result--ad)",
    "search_link": "a.result__a",
    "search_snippet": ".result__snippet",
    "search_blocked_text": r"bots use duckduckgo|unusual activity|anomaly",
}

# ---------------------------------------------------------------------------
# Hard caps. Env overrides exist for tuning, but no cap can be raised from a
# tool call.
# ---------------------------------------------------------------------------


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


CONFIG: dict[str, Any] = {
    "limit_default": 50,
    "limit_max": 120,
    "saturation_count": 120,               # Google's feed cap
    "timeout_s": _env_float("HARVEST_TIMEOUT_S", 60.0),
    "pause_min_s": _env_float("HARVEST_PAUSE_MIN_S", 1.8),
    "pause_max_s": _env_float("HARVEST_PAUSE_MAX_S", 4.5),
    "max_consecutive_empty": _env_int("HARVEST_MAX_CONSECUTIVE_EMPTY", 5),
    "max_calls": _env_int("HARVEST_MAX_CALLS", 500),   # per process
    "challenge_cooldown_s": _env_float("HARVEST_CHALLENGE_COOLDOWN_S", 900.0),
    "max_scroll_rounds": 40,
    "stall_rounds": 3,
    "feed_wait_s": 20.0,
    "detail_wait_s": 15.0,
    "headless": os.environ.get("HARVEST_HEADLESS", "1") != "0",
}

_ALLOWED_MAPS_HOSTS = {"www.google.com", "google.com", "maps.google.com", "maps.app.goo.gl"}

# ---------------------------------------------------------------------------
# Live selectors. The gateway copies the active_selectors table (the
# Mechanic's fixes) to HARVEST_SELECTORS_FILE as {"version", "selectors"};
# this process holds no database credentials, so it only reads that file.
# The table uses the script harvester's key names: website_btn maps onto
# card_website; rating is ignored (it names a different element there).
# Anything invalid falls back to the built-in SELECTORS above.
# ---------------------------------------------------------------------------
_BUILTIN_SELECTORS = dict(SELECTORS)
_BUILTIN_VERSION = SELECTOR_VERSION
SELECTORS_FILE = os.environ.get("HARVEST_SELECTORS_FILE", "")
_TABLE_KEY_MAP = {"website_btn": "card_website"}
_TABLE_KEY_IGNORED = {"rating"}
_REGEX_KEYS = {k for k in _BUILTIN_SELECTORS if k.endswith("_text")} | {"challenge_url"}
_PLAIN_KEYS = {"consent_host"}
# file mtime last looked at; whether the table set passed the in-page check; versions that failed it
_live = {"mtime": None, "source": "builtin", "checked": True, "rejected": set()}


def merge_selectors(table: Any) -> dict[str, str]:
    """Built-in selectors overlaid with an active_selectors row. Raises ValueError if any value is unusable."""
    if not isinstance(table, dict):
        raise ValueError("selectors must be an object")
    merged = dict(_BUILTIN_SELECTORS)
    for key, value in table.items():
        if key in _TABLE_KEY_IGNORED:
            continue
        name = _TABLE_KEY_MAP.get(key, key)
        if name not in _BUILTIN_SELECTORS:
            continue
        if not isinstance(value, str) or not value.strip() or len(value) > 500 or re.search(r"[\x00-\x1f]", value):
            raise ValueError(f"bad value for {key}")
        if name in _REGEX_KEYS:
            try:
                re.compile(value)
            except re.error as exc:
                raise ValueError(f"bad regex for {key}: {exc}") from None
        merged[name] = value
    return merged


def _use_builtin() -> None:
    global SELECTORS, SELECTOR_VERSION
    SELECTORS, SELECTOR_VERSION = dict(_BUILTIN_SELECTORS), _BUILTIN_VERSION
    _live.update(source="builtin", checked=True)


def refresh_selectors() -> None:
    """Re-read SELECTORS_FILE if it changed since the last call (one stat per call)."""
    global SELECTORS, SELECTOR_VERSION
    if not SELECTORS_FILE:
        return
    try:
        mtime = os.stat(SELECTORS_FILE).st_mtime_ns
    except OSError:
        mtime = None
    if mtime == _live["mtime"]:
        return
    _live["mtime"] = mtime
    if mtime is None:
        _use_builtin()
        return
    try:
        with open(SELECTORS_FILE, encoding="utf-8") as fh:
            row = json.load(fh)
        version = str(row.get("version") or "").strip()
        if not version or len(version) > 64:
            raise ValueError("missing version")
        if version in _live["rejected"]:
            raise ValueError(f"version {version} failed the in-page check")
        merged = merge_selectors(row.get("selectors"))
    except Exception as exc:  # noqa: BLE001
        log.warning("active selectors not used (%s); using built-in %s", exc, _BUILTIN_VERSION)
        _use_builtin()
        return
    SELECTORS, SELECTOR_VERSION = merged, version
    _live.update(source="table", checked=False)
    log.info("selectors %s loaded from %s", version, SELECTORS_FILE)


_JS_BAD_SELECTORS = r"""
(S) => Object.keys(S).filter((k) => { try { document.querySelector(S[k]); return false; } catch (e) { return true; } })
"""


async def _check_live_selectors(page) -> None:
    """First use of a table selector set: reject it if any CSS selector doesn't parse."""
    if _live["checked"]:
        return
    css = {k: v for k, v in SELECTORS.items() if k not in _REGEX_KEYS and k not in _PLAIN_KEYS}
    bad = await page.evaluate(_JS_BAD_SELECTORS, css)
    if bad:
        log.warning("selectors %s rejected, invalid CSS for %s; using built-in %s", SELECTOR_VERSION, bad, _BUILTIN_VERSION)
        _live["rejected"].add(SELECTOR_VERSION)
        _use_builtin()
    else:
        _live["checked"] = True


class HarvestError(Exception):
    def __init__(self, code: str, **extra: Any):
        super().__init__(code)
        self.code = code
        self.extra = extra


def error(code: str, **extra: Any) -> dict:
    return {"error": code, "selector_version": SELECTOR_VERSION, **extra}


# ---------------------------------------------------------------------------
# Guard: process-wide budget, empty-result circuit breaker, challenge cooldown.
# ---------------------------------------------------------------------------
class Guard:
    def __init__(self) -> None:
        self.calls = 0
        self.consecutive_empty = 0
        self.challenge_until = 0.0
        self.last_nav = 0.0

    def check(self) -> Optional[dict]:
        now = time.monotonic()
        if now < self.challenge_until:
            return error("challenge_detected", retry_after_s=int(self.challenge_until - now))
        if self.consecutive_empty >= CONFIG["max_consecutive_empty"]:
            return error("circuit_open", consecutive_empty=self.consecutive_empty)
        if self.calls >= CONFIG["max_calls"]:
            return error("budget_exhausted", calls=self.calls)
        return None

    def note_result(self, count: int) -> None:
        self.consecutive_empty = 0 if count > 0 else self.consecutive_empty + 1

    def trip_challenge(self) -> None:
        self.challenge_until = time.monotonic() + CONFIG["challenge_cooldown_s"]

    def status(self) -> dict:
        now = time.monotonic()
        return {
            "calls": self.calls,
            "max_calls": CONFIG["max_calls"],
            "consecutive_empty": self.consecutive_empty,
            "circuit_open": self.consecutive_empty >= CONFIG["max_consecutive_empty"],
            "challenge_cooldown_remaining_s": max(0, int(self.challenge_until - now)),
        }


guard = Guard()


# ---------------------------------------------------------------------------
# Browser: one Camoufox instance reused for the life of the process.
# ---------------------------------------------------------------------------
class Browser:
    def __init__(self) -> None:
        self._cm = None
        self._browser = None
        self._page = None
        self.tab = None  # general-browsing page (browse.py), own context
        self.lock = asyncio.Lock()

    @property
    def alive(self) -> bool:
        return self._page is not None and not self._page.is_closed()

    async def page(self):
        if self.alive:
            return self._page
        await self.close()
        from camoufox.async_api import AsyncCamoufox  # imported lazily: slow

        # HARVEST_PROXY (http://user:pass@host:port): a residential proxy lets
        # Maps work from a datacenter IP (Railway) that Google blocks.
        proxy = os.environ.get("HARVEST_PROXY")
        log.info("launching camoufox (headless=%s, proxy=%s)", CONFIG["headless"], bool(proxy))
        self._cm = AsyncCamoufox(
            headless=CONFIG["headless"],
            humanize=True,
            geoip=True,  # with a proxy, geolocates the proxy's exit IP
            block_webrtc=True,
            window=(tiles.VIEWPORT_W, tiles.VIEWPORT_H),
            **({"proxy": _proxy_settings(proxy)} if proxy else {}),
        )
        self._browser = await self._cm.__aenter__()
        self._page = await self._browser.new_page()
        self._page.set_default_timeout(15_000)
        return self._page

    async def browse_tab(self, on_request):
        """The general-browsing page. It lives in its own context, so it never
        touches the Maps page's cookies or state; `on_request` routes every
        request in that context (popups included)."""
        await self.page()
        if self.tab is None or self.tab.is_closed():
            ctx = await self._browser.new_context()
            await ctx.route("**/*", on_request)
            self.tab = await ctx.new_page()
            self.tab.set_default_timeout(15_000)
        return self.tab

    async def close(self) -> None:
        self.tab = None
        cm, self._cm, self._browser, self._page = self._cm, None, None, None
        if cm is not None:
            try:
                await cm.__aexit__(None, None, None)
            except Exception:  # noqa: BLE001 - shutting down anyway
                pass


def _proxy_settings(url: str) -> dict:
    """Playwright wants proxy credentials as separate fields, not in the URL."""
    p = urlparse(url)
    out = {"server": f"{p.scheme or 'http'}://{p.hostname}:{p.port}" if p.port else f"{p.scheme or 'http'}://{p.hostname}"}
    if p.username:
        out.update(username=unquote(p.username), password=unquote(p.password or ""))
    return out


browser = Browser()


# ---------------------------------------------------------------------------
# In-page extractors. Selectors are passed in as an argument so the JS never
# hard-codes a DOM detail. Each returns a small plain object.
# ---------------------------------------------------------------------------
_JS_PAGE_STATE = r"""
(S) => {
  const body = document.body ? (document.body.innerText || '') : '';
  return {
    feed: !!document.querySelector(S.feed),
    main: !!document.querySelector(S.detail_title),
    no_results: new RegExp(S.no_results_text, 'i').test(body.slice(0, 4000)),
    challenge: !!document.querySelector(S.challenge_dom) ||
               new RegExp(S.challenge_text, 'i').test(body.slice(0, 5000)),
    consent: !!document.querySelector(S.consent_button),
    end_of_list: new RegExp(S.end_of_list_text, 'i').test(body),
  };
}
"""

_JS_EXTRACT_CARDS = r"""
(S) => {
  const feed = document.querySelector(S.feed);
  if (!feed) return null;
  // hours/status parts of a meta row ("Open 24 hours", "Closed · Opens 8 AM Mon")
  const STATUS = /^(open|closed|opens|closes|temporarily|permanently)\b/i;
  const PHONE = /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
  // Maps renders icon-font glyphs (private-use codepoints) inside text nodes.
  const clean = s => (s || '').replace(/[-\u{F0000}-\u{10FFFF}]/gu, '').replace(/[ \t]+/g, ' ').trim();
  const seen = new Set();
  const out = [];
  for (const link of feed.querySelectorAll(S.card_link)) {
    const name = clean(link.getAttribute('aria-label'));
    if (!name) continue;                       // photo / marker links
    const href = link.href;
    if (seen.has(href)) continue;
    seen.add(href);
    const card = link.closest(S.card) || link.parentElement;
    if (!card) continue;

    let rating = null, review_count = null;
    const badge = card.querySelector(S.card_rating);
    if (badge) {
      const label = badge.getAttribute('aria-label') || '';
      const r = label.match(/([\d.]+)\s*star/i);
      if (r) rating = parseFloat(r[1]);
      const m = label.match(/([\d,.]+)\s*([kKmM]?)\s*review/i);
      if (m) {
        let n = parseFloat(m[1].replace(/,/g, ''));
        if (/k/i.test(m[2])) n *= 1000;
        if (/m/i.test(m[2])) n *= 1e6;
        if (!Number.isNaN(n)) review_count = Math.round(n);
      }
    }

    let maps_cid = null;
    const hex = href.match(/0x[0-9a-f]+:0x([0-9a-f]+)/i);
    if (hex) { try { maps_cid = BigInt('0x' + hex[1]).toString(); } catch (e) {} }
    if (!maps_cid) { try { maps_cid = new URL(href).searchParams.get('cid'); } catch (e) {} }

    const web = card.querySelector(S.card_website);
    // Sponsored cards link the Website button through Google's ad redirect
    // (/aclk). Report the advertiser's real URL (adurl) when it's in there.
    let website_url = web ? (web.href || null) : null, sponsored = false;
    if (website_url && /\/aclk\b|googleadservices\.com/.test(website_url)) {
      sponsored = true;
      try { website_url = new URL(website_url).searchParams.get('adurl') || null; } catch (e) { website_url = null; }
    }
    const text = clean(card.innerText);

    let category_label = null, address_line = null;
    const rows = new Set();
    for (const el of card.querySelectorAll(S.card_meta_row)) {
      for (const line of (el.innerText || '').split('\n')) {
        const t = clean(line);
        if (t) rows.add(t);
      }
    }
    const RATING_ROW = /^\d[\d.,]*\s*\(/;   // "4.8(204)"
    for (const row of rows) {
      const parts = row.split('·').map(s => s.trim()).filter(Boolean);
      if (!parts.length || STATUS.test(parts[0]) || PHONE.test(parts[0]) || RATING_ROW.test(parts[0])) continue;
      category_label = parts[0];
      // Service-area businesses show no address: the row is the category alone.
      if (parts[1] && !STATUS.test(parts[1]) && !PHONE.test(parts[1])) address_line = parts[1];
      break;
    }
    const ph = text.match(PHONE);
    const ll = href.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);

    out.push({
      name,
      maps_cid,
      // canonical short form; the /data=... variant is ~200 bytes per card
      maps_url: maps_cid ? 'https://www.google.com/maps?cid=' + maps_cid : href.split('?')[0],
      rating,
      review_count,
      has_website: !!web,
      website_url,
      sponsored,
      address_line,
      phone: ph ? ph[0] : null,
      category_label,
      // extended-only fields (harvest_tile strips them unless extended=true)
      lat: ll ? Number(ll[1]) : null,
      lng: ll ? Number(ll[2]) : null,
      closed: /(^|\n)\s*(permanently|temporarily) closed/i.test(text),
    });
  }
  return out;
}
"""

_JS_EXTRACT_DETAIL = r"""
(S) => {
  const main = document.querySelector(S.detail_main);
  if (!main) return null;
  const q = sel => main.querySelector(sel);
  const clean = s => (s || '').replace(/[-\u{F0000}-\u{10FFFF}]/gu, '').replace(/[ \t]+/g, ' ').trim();
  const text = main.innerText || '';
  const attr = (el, a) => el ? (clean(el.getAttribute(a)) || null) : null;

  const h1 = q('h1');
  const web = q(S.detail_website);
  const phoneBtn = q(S.detail_phone);
  let phone = null;
  if (phoneBtn) {
    const id = attr(phoneBtn, 'data-item-id') || '';
    phone = id.replace(/^phone:tel:/, '') || null;
    if (!phone) { const m = (attr(phoneBtn, 'aria-label') || '').match(/[\d\s().+-]{7,}/); phone = m ? m[0].trim() : null; }
  }
  const addrBtn = q(S.detail_address);
  const address = addrBtn ? (clean((attr(addrBtn, 'aria-label') || addrBtn.innerText || '').replace(/^address:\s*/i, '')) || null) : null;
  const catBtn = q(S.detail_category);

  let hours = null;
  const rows = main.querySelectorAll(S.detail_hours_row);
  if (rows.length) {
    hours = {};
    for (const tr of rows) {
      const cells = tr.querySelectorAll('td');
      if (cells.length >= 2) {
        const day = clean(cells[0].innerText);
        const val = Array.from(cells[1].querySelectorAll('li')).map(li => clean(li.innerText)).filter(Boolean).join(', ')
                    || clean(cells[1].innerText);
        if (day) hours[day] = val;
      }
    }
    if (!Object.keys(hours).length) hours = null;
  }
  if (!hours) {
    const hb = q(S.detail_hours_button);
    if (hb) hours = attr(hb, 'aria-label');
  }

  let rating = null, review_count = null;
  const rEl = q(S.detail_rating);
  if (rEl) { const v = parseFloat((rEl.innerText || '').replace(',', '.')); if (!Number.isNaN(v)) rating = v; }
  const rc = q(S.detail_review_count);
  if (rc) { const m = (attr(rc, 'aria-label') || rc.innerText || '').match(/([\d,]+)/); if (m) review_count = parseInt(m[1].replace(/,/g, ''), 10); }

  return {
    name: h1 ? (clean(h1.innerText) || null) : null,
    website_url: web ? (web.href || null) : null,
    phone,
    address,
    category_label: catBtn ? (clean(catBtn.innerText) || null) : null,
    hours,
    rating,
    review_count,
    claim_present: !!q(S.detail_claim) || new RegExp(S.detail_claim_text, 'i').test(text),
    permanently_closed: new RegExp(S.detail_closed_text, 'i').test(text),
    temporarily_closed: new RegExp(S.detail_temp_closed_text, 'i').test(text),
  };
}
"""

_JS_EXTRACT_REVIEWS = r"""
(S) => {
  const items = Array.from(document.querySelectorAll(S.review_item));
  const resp = new RegExp(S.review_owner_response_text, 'i');
  let owner_response_count = 0;
  const dates = [];
  for (const it of items) {
    const d = it.querySelector(S.review_date);
    if (d) dates.push((d.innerText || '').replace(/[-]/g, '').trim());
    if (resp.test(it.innerText || '')) owner_response_count++;
  }
  return { sampled: items.length, dates, owner_response_count };
}
"""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
_EMPTY_STATE = {"feed": False, "main": False, "no_results": False, "challenge": False, "consent": False, "end_of_list": False}


async def _pace() -> None:
    """Randomised human pause between page loads (skipped before the first)."""
    if guard.last_nav:
        await asyncio.sleep(random.uniform(CONFIG["pause_min_s"], CONFIG["pause_max_s"]))


async def _page_state(page) -> dict:
    try:
        return await page.evaluate(_JS_PAGE_STATE, SELECTORS)
    except Exception:  # noqa: BLE001 - page mid-navigation
        return dict(_EMPTY_STATE)


def _raise_challenge() -> None:
    guard.trip_challenge()
    raise HarvestError("challenge_detected", retry_after_s=int(CONFIG["challenge_cooldown_s"]))


async def _challenge_present(page, state: Optional[dict] = None) -> bool:
    if re.search(SELECTORS["challenge_url"], page.url or ""):
        return True
    if state is None:
        state = await _page_state(page)
    return bool(state.get("challenge"))


async def _dismiss_consent(page) -> None:
    host = urlparse(page.url or "").netloc
    state = await _page_state(page)
    if SELECTORS["consent_host"] not in host and not state.get("consent"):
        return
    log.info("consent interstitial detected; dismissing")
    try:
        await page.locator(SELECTORS["consent_button"]).first.click(timeout=5_000)
        await page.wait_for_load_state("domcontentloaded", timeout=15_000)
        await asyncio.sleep(random.uniform(1.0, 2.0))
    except Exception as exc:  # noqa: BLE001
        log.warning("consent dismissal failed: %s", type(exc).__name__)


async def _goto(page, url: str) -> None:
    await _pace()
    await page.goto(url, wait_until="domcontentloaded", timeout=30_000)
    guard.last_nav = time.monotonic()
    await _dismiss_consent(page)
    if await _challenge_present(page):
        _raise_challenge()


async def _wait_for(page, key: str, seconds: float) -> dict:
    """Poll page state until `state[key]` or no_results; raise on challenge."""
    deadline = time.monotonic() + seconds
    state: dict = dict(_EMPTY_STATE)
    while time.monotonic() < deadline:
        state = await _page_state(page)
        if await _challenge_present(page, state):
            _raise_challenge()
        if state.get(key) or state.get("no_results"):
            return state
        await asyncio.sleep(0.7)
    return state


async def _scroll_feed(page) -> None:
    feed = page.locator(SELECTORS["feed"]).first
    try:
        await feed.hover(timeout=3_000)
        await page.mouse.wheel(0, random.randint(2000, 3200))
    except Exception:  # noqa: BLE001
        await feed.evaluate("el => { el.scrollTop = el.scrollHeight; }")


def _validate_maps_url(url: str) -> None:
    try:
        p = urlparse(url)
    except Exception:  # noqa: BLE001
        raise HarvestError("invalid_argument", reason="unparseable maps_url") from None
    if p.scheme != "https" or p.netloc not in _ALLOWED_MAPS_HOSTS:
        raise HarvestError("invalid_argument", reason="maps_url must be an https google.com/maps URL")


def _cid_from_url(url: str) -> Optional[str]:
    m = re.search(r"0x[0-9a-f]+:0x([0-9a-f]+)", url or "", re.I)
    if m:
        return str(int(m.group(1), 16))
    m = re.search(r"[?&]cid=(\d+)", url or "")
    return m.group(1) if m else None


def _relative_to_iso(text: Optional[str]) -> Optional[str]:
    """'3 months ago' -> approximate ISO date. None if unparseable."""
    if not text:
        return None
    t = text.lower()
    if re.search(r"just now|minute|hour|today", t):
        return date.today().isoformat()
    m = re.search(r"(a|an|\d+)\s+(day|week|month|year)s?\s+ago", t)
    if not m:
        return None
    n = 1 if m.group(1) in ("a", "an") else int(m.group(1))
    days = {"day": 1, "week": 7, "month": 30, "year": 365}[m.group(2)] * n
    return (date.today() - timedelta(days=days)).isoformat()


def _relative_days(text: str) -> int:
    iso = _relative_to_iso(text)
    return (date.today() - date.fromisoformat(iso)).days if iso else 10**6


async def _run(body, partial: Optional[dict] = None, guarded: bool = True) -> dict:
    """Wrap a tool body with the guard, the timeout and error normalisation.

    guarded=False (general browsing) skips the Maps budget, circuit breaker
    and challenge cooldown: a blocked random site says nothing about Maps.
    """
    refresh_selectors()
    if guarded:
        gate = guard.check()
        if gate:
            return gate
        guard.calls += 1
    try:
        return await asyncio.wait_for(body(), timeout=CONFIG["timeout_s"])
    except asyncio.TimeoutError:
        if guarded:
            guard.note_result(0)
        out = error("timeout", timeout_s=CONFIG["timeout_s"])
        if partial and partial.get("results"):
            out["partial_results"] = partial["results"]
        return out
    except HarvestError as exc:
        return error(exc.code, **exc.extra)
    except Exception as exc:  # noqa: BLE001
        log.exception("internal error")
        await browser.close()  # relaunch on next call
        return error("internal", exception=type(exc).__name__)


def _card_from_detail(d: dict, url: str) -> dict:
    cid = _cid_from_url(url)
    ll = re.search(r"!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)", url or "")
    return {
        "name": d["name"],
        "maps_cid": cid,
        "maps_url": f"https://www.google.com/maps?cid={cid}" if cid else url.split("?")[0],
        "rating": d["rating"],
        "review_count": d["review_count"],
        "has_website": bool(d["website_url"]),
        "website_url": d["website_url"],
        "sponsored": False,
        "address_line": d["address"],
        "phone": d["phone"],
        "category_label": d["category_label"],
        "lat": float(ll.group(1)) if ll else None,
        "lng": float(ll.group(2)) if ll else None,
        "closed": bool(d.get("permanently_closed") or d.get("temporarily_closed")),
    }


_EXTENDED_FIELDS = ("lat", "lng", "closed")


def _strip_extended(cards: list) -> list:
    return [{k: v for k, v in c.items() if k not in _EXTENDED_FIELDS} for c in cards]


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
async def harvest_tile(category: str, lat: float, lng: float, zoom: int, limit: Optional[int] = None,
                       extended: bool = False) -> dict:
    """extended=True adds lat, lng (from the card link) and closed to each card."""
    partial: dict = {"results": []}

    async def body() -> dict:
        lim = CONFIG["limit_default"] if limit is None else int(limit)
        lim = max(1, min(lim, CONFIG["limit_max"]))
        if not category or not category.strip():
            raise HarvestError("invalid_argument", reason="category is required")
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            raise HarvestError("invalid_argument", reason="lat/lng out of range")
        if not (tiles.MIN_ZOOM <= int(zoom) <= tiles.MAX_ZOOM):
            raise HarvestError("invalid_argument", reason=f"zoom must be {tiles.MIN_ZOOM}-{tiles.MAX_ZOOM}")

        base = {"selector_version": SELECTOR_VERSION, "category": category, "lat": lat, "lng": lng, "zoom": int(zoom)}

        async with browser.lock:
            page = await browser.page()
            await _check_live_selectors(page)
            base["selector_version"] = SELECTOR_VERSION
            await _goto(page, tiles.maps_url(category, lat, lng, int(zoom)))
            state = await _wait_for(page, "feed", CONFIG["feed_wait_s"])

            if state.get("no_results"):
                guard.note_result(0)
                return {**base, "results": [], "saturated": False, "truncated": False, "no_results": True}

            if not state.get("feed"):
                # A search with exactly one match redirects straight to the
                # place page. Surface it as a one-card result.
                if "/maps/place/" in (page.url or "") and state.get("main"):
                    d = await page.evaluate(_JS_EXTRACT_DETAIL, SELECTORS)
                    if d and d.get("name"):
                        guard.note_result(1)
                        return {**base, "results": [_card_from_detail(d, page.url)], "saturated": False,
                                "truncated": False, "single_place_redirect": True}
                guard.note_result(0)
                raise HarvestError("selectors_stale", hint="results feed not found")

            cards: list = []
            last = 0
            stall = 0
            end_reached = False
            for _ in range(CONFIG["max_scroll_rounds"]):
                extracted = await page.evaluate(_JS_EXTRACT_CARDS, SELECTORS)
                if extracted is None:
                    raise HarvestError("selectors_stale", hint="feed disappeared mid-scroll")
                cards = extracted
                partial["results"] = cards[:lim]
                n = len(cards)
                if n >= lim:
                    break
                st = await _page_state(page)
                if st.get("challenge"):
                    _raise_challenge()
                if st.get("end_of_list"):
                    end_reached = True
                    break
                if n == last:
                    stall += 1
                    if stall >= CONFIG["stall_rounds"]:
                        break
                else:
                    stall, last = 0, n
                await _scroll_feed(page)
                await asyncio.sleep(random.uniform(0.9, 1.8))

            total = len(cards)
            results = cards[:lim]
            guard.note_result(len(results))
            return {
                **base,
                "results": results,
                "saturated": total >= CONFIG["saturation_count"],
                "truncated": total >= lim and not end_reached,
                "total_seen": total,
            }

    out = await _run(body, partial)
    if not extended:
        for key in ("results", "partial_results"):
            if isinstance(out.get(key), list):
                out[key] = _strip_extended(out[key])
    return out


async def listing_detail(maps_url: str) -> dict:
    async def body() -> dict:
        _validate_maps_url(maps_url)
        async with browser.lock:
            page = await browser.page()
            await _check_live_selectors(page)
            await _goto(page, maps_url)
            state = await _wait_for(page, "main", CONFIG["detail_wait_s"])
            if not state.get("main"):
                guard.note_result(0)
                raise HarvestError("selectors_stale", hint="detail panel not found")
            await asyncio.sleep(random.uniform(0.8, 1.5))  # panel fills in lazily
            d = await page.evaluate(_JS_EXTRACT_DETAIL, SELECTORS)
            if not d or not d.get("name"):
                guard.note_result(0)
                raise HarvestError("selectors_stale", hint="detail panel parsed empty")
            guard.note_result(1)
            return {
                "selector_version": SELECTOR_VERSION,
                "name": d["name"],
                "maps_cid": _cid_from_url(maps_url) or _cid_from_url(page.url),
                "website_url": d["website_url"],
                "phone": d["phone"],
                "address": d["address"],
                "category_label": d["category_label"],
                "rating": d["rating"],
                "review_count": d["review_count"],
                "is_unclaimed": bool(d["claim_present"]),
                "hours": d["hours"],
                # Photo timestamps are only rendered inside the photo viewer,
                # not on the listing panel; opening it costs extra page loads.
                "last_photo_date": None,
                "permanently_closed": bool(d["permanently_closed"]),
                "temporarily_closed": bool(d["temporarily_closed"]),
            }

    return await _run(body)


async def check_operating(maps_url: str) -> dict:
    async def body() -> dict:
        _validate_maps_url(maps_url)
        async with browser.lock:
            page = await browser.page()
            await _check_live_selectors(page)
            await _goto(page, maps_url)
            state = await _wait_for(page, "main", CONFIG["detail_wait_s"])
            if not state.get("main"):
                guard.note_result(0)
                raise HarvestError("selectors_stale", hint="detail panel not found")
            await asyncio.sleep(random.uniform(0.8, 1.5))
            d = await page.evaluate(_JS_EXTRACT_DETAIL, SELECTORS) or {}
            # Read the cid before opening reviews: that tab's URL carries other ids.
            cid = _cid_from_url(maps_url) or _cid_from_url(page.url)

            reviews: dict = {"sampled": 0, "dates": [], "owner_response_count": 0}
            sort_applied = False
            try:
                await page.locator(SELECTORS["reviews_tab"]).first.click(timeout=5_000)
                await asyncio.sleep(random.uniform(1.2, 2.0))
                try:
                    await page.locator(SELECTORS["reviews_sort_button"]).first.click(timeout=4_000)
                    await asyncio.sleep(random.uniform(0.5, 0.9))
                    await page.locator(SELECTORS["reviews_sort_newest"]).first.click(timeout=4_000)
                    await asyncio.sleep(random.uniform(1.2, 2.0))
                    sort_applied = True
                except Exception:  # noqa: BLE001 - keep "most relevant" order
                    pass
                reviews = await page.evaluate(_JS_EXTRACT_REVIEWS, SELECTORS) or reviews
            except Exception:  # noqa: BLE001 - no reviews tab: listing has no reviews
                pass

            dates = [x for x in reviews.get("dates", []) if x]
            newest = min(dates, key=_relative_days) if dates else None
            guard.note_result(1 if d.get("name") else 0)
            return {
                "selector_version": SELECTOR_VERSION,
                "name": d.get("name"),
                "maps_cid": cid,
                "permanently_closed": bool(d.get("permanently_closed")),
                "temporarily_closed": bool(d.get("temporarily_closed")),
                "most_recent_review_date": _relative_to_iso(newest),
                "most_recent_review_relative": newest,
                "review_count": d.get("review_count"),
                "reviews_sampled": reviews.get("sampled", 0),
                "reviews_sorted_newest": sort_applied,
                "owner_responds": reviews.get("owner_response_count", 0) > 0,
                "owner_response_count": reviews.get("owner_response_count", 0),
            }

    return await _run(body)


# ---------------------------------------------------------------------------
# Web presence: does a "no website on Maps" business have a site anyway?
# ---------------------------------------------------------------------------
# Second-level domains that list businesses but are not the business's own site.
_DIRECTORY_SLDS = {
    "yelp", "bbb", "yellowpages", "mapquest", "angi", "angieslist", "homeadvisor", "thumbtack",
    "nextdoor", "linkedin", "manta", "chamberofcommerce", "buildzoom", "porch", "houzz", "google",
    "apple", "bing", "dnb", "bizapedia", "opencorporates", "cylex", "cylex-usa", "superpages",
    "citysearch", "merchantcircle", "alignable", "twitter", "x", "youtube", "tiktok", "pinterest",
    "indeed", "glassdoor", "birdeye", "brownbook", "hotfrog", "loc8nearme", "showmelocal", "n49",
    "ezlocal", "trustdale", "expertise", "bark", "networx", "fixr", "wikipedia", "reddit",
    "duckduckgo", "local", "yahoo", "foursquare", "zoominfo", "buzzfile", "facebook", "instagram",
    "cityof", "contractorlicensepro", "myhomepro", "opengovus", "411", "allbiz",
}
_TRADE_WORDS = {
    "plumbing", "plumber", "plumbers", "electric", "electrical", "electrician", "roofing", "roofer",
    "hvac", "heating", "cooling", "air", "lawn", "landscaping", "landscape", "cleaning", "cleaners",
    "services", "service", "repair", "repairs", "construction", "contractor", "contractors",
    "auto", "pest", "control", "painting", "painters", "tree", "pool", "pools", "home", "homes",
    "company", "group", "solutions", "pros", "professional", "texas", "dallas", "llc", "inc",
    "the", "and", "of", "co", "corp",
}
_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_PHONE_RE = re.compile(r"\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}")

_JS_EXTRACT_SEARCH = r"""
(S) => ({
  blocked: new RegExp(S.search_blocked_text, 'i').test((document.body && document.body.innerText || '').slice(0, 3000)),
  results: Array.from(document.querySelectorAll(S.search_result)).slice(0, 15).map(r => {
    const a = r.querySelector(S.search_link), s = r.querySelector(S.search_snippet);
    return { href: a ? a.href : null, title: a ? a.innerText.trim() : '', snippet: s ? s.innerText.trim() : '' };
  }).filter(r => r.href),
})
"""


def _host(url: str) -> str:
    """Real destination host; unwraps DuckDuckGo's /l/?uddg= redirect."""
    p = urlparse(url)
    if "duckduckgo.com" in p.netloc and p.path.startswith("/l/"):
        target = parse_qs(p.query).get("uddg", [""])[0]
        p = urlparse(target) if target else p
    return p.netloc.lower().removeprefix("www.")


def _real_url(url: str) -> str:
    p = urlparse(url)
    if "duckduckgo.com" in p.netloc and p.path.startswith("/l/"):
        return parse_qs(p.query).get("uddg", [url])[0]
    return url


def _digits(s: Optional[str]) -> str:
    return re.sub(r"\D", "", s or "")[-10:]


def _name_words(name: str) -> list[str]:
    """Distinctive words of a business name: no trade words, no 1-letter noise."""
    return [w for w in re.findall(r"[a-z0-9]+", name.lower()) if len(w) >= 2 and w not in _TRADE_WORDS]


def match_card(name: str, phone: Optional[str], cards: list[dict]) -> tuple[Optional[dict], Optional[str]]:
    """Pure: pick the Maps card that is this business, by phone, else by name.

    Name match = every distinctive word of `name` appears as a word of the
    card's name ("DEAN ELECTRIC, INC" ~ "Dean Electric Inc"). A search for a
    name Maps doesn't know returns other businesses; those must not match.
    """
    want = _digits(phone)
    if want:
        for c in cards:
            if _digits(c.get("phone")) == want:
                return c, "phone"
    words = set(_name_words(name))
    if words:
        for c in cards:
            if words <= set(re.findall(r"[a-z0-9]+", (c.get("name") or "").lower())):
                return c, "name"
    return None, None


def classify_presence(name: str, phone: Optional[str], results: list[dict]) -> dict:
    """Pure: turn search results into a web-presence verdict (no browser).

    A result counts as the business's own site when its host is not a
    directory/social site AND either its domain contains a distinctive word
    of the business name or its snippet carries the business's phone number.
    Only a name match flips the verdict: a phone-only hit is usually a
    directory missing from _DIRECTORY_SLDS, so it is listed for review only.
    """
    # ponytail: word-in-domain heuristic; misses sites named unlike the business
    # (e.g. initials). web_presence backs it up with verify_sites (phone on page).
    words = _name_words(name)
    want_phone = _digits(phone)
    own: list[dict] = []
    facebook = instagram = None
    emails: set[str] = set()
    phone_seen = False
    for r in results:
        url, host = _real_url(r["href"]), _host(r["href"])
        text = f"{r.get('title', '')} {r.get('snippet', '')}"
        emails.update(e.lower() for e in _EMAIL_RE.findall(text) if not e.lower().endswith((".png", ".jpg")))
        phone_hit = bool(want_phone) and any(_digits(m) == want_phone for m in _PHONE_RE.findall(text))
        phone_seen = phone_seen or phone_hit
        if "facebook.com" in host:
            facebook = facebook or url
            continue
        if "instagram.com" in host:
            instagram = instagram or url
            continue
        parts = host.split(".")
        sld = parts[-2] if len(parts) >= 2 else host
        if not host or sld in _DIRECTORY_SLDS or host.endswith(".gov"):
            continue
        label = sld.replace("-", "")
        # 2-letter words ("SK Electric") only count as the start of the domain.
        name_hit = any(w in label if len(w) >= 3 else label.startswith(w) for w in words)
        if (name_hit or phone_hit) and all(_host(o["url"]) != host for o in own):
            own.append({"url": url, "matched": "name+phone" if name_hit and phone_hit else "name" if name_hit else "phone"})
    if any(o["matched"] != "phone" for o in own):
        verdict = "likely_has_website"
    elif results:
        verdict = "no_website_found"
    else:
        verdict = "unknown"
    return {
        "verdict": verdict,
        "candidate_websites": own[:3],
        "facebook": facebook,
        "instagram": instagram,
        "emails": sorted(emails)[:5],
        "phone_seen_online": phone_seen,
        "results_checked": len(results),
    }


# ---------------------------------------------------------------------------
# On-page verification: fetch candidate sites (search hits the name heuristic
# missed + guessed domains) and look for the lead's phone number. Plain HTTP
# (urllib), not the browser: parallel, and it never queues behind Maps.
# ---------------------------------------------------------------------------
_LEGAL_WORDS = {"llc", "inc", "co", "corp", "corporation", "ltd", "lp", "pllc", "company", "the"}
_SEP = r"[\s.\-\u2010-\u2015]?"  # incl. typographic dashes sites use (&#8209;, en dash)
_PAGE_PHONE_RE = re.compile(rf"(?<!\d)\(?([2-9]\d{{2}})\)?{_SEP}(\d{{3}}){_SEP}(\d{{4}})(?!\d)")
_TEL_RE = re.compile(rf"tel:\+?1?{_SEP}\(?(\d{{3}})\)?{_SEP}(\d{{3}}){_SEP}(\d{{4}})", re.I)
_TAGS_RE = re.compile(r"<(script|style|noscript)\b.*?</\1>|<[^>]+>", re.I | re.S)
MAX_PHONES_OWN_SITE = 5    # directory/listing pages carry many numbers; own sites a few
MAX_SEARCH_HITS_TO_FETCH = 4
FETCH_TIMEOUT_S = 8.0
_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0"


@functools.lru_cache(maxsize=1024)
def _host_is_public(host: str) -> bool:
    """True only if every address `host` resolves to is globally routable.

    Guards every fetch/browse from this home-network process: no localhost,
    LAN, link-local, CGNAT/Tailscale. NXDOMAIN -> False (fast skip for
    guessed domains that don't exist).
    """
    # ponytail: resolve-then-connect, so a DNS-rebinding host could still flip
    # between this check and the real lookup. Upgrade path: pin the resolved IP.
    if not host:
        return False
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return False
    return bool(infos) and all(ipaddress.ip_address(i[4][0].split("%")[0]).is_global for i in infos)


def guess_domains(name: str) -> list[str]:
    """Pure: likely own-site domains for a business name ("Joe's Plumbing LLC"
    -> joesplumbing.com, joesplumbingtx.com, ...). Trade words are kept: small
    trade businesses usually put them in the domain. "Owner DBA Trade Name"
    guesses from the trade name."""
    dba = re.split(r"\bd\s*/?\s*b\s*/?\s*a\b[:\s]*", name, maxsplit=1, flags=re.I)
    name = dba[-1].strip(" ()") or name
    words = [w for w in re.findall(r"[a-z0-9]+", name.lower().replace("&", " and ")) if w not in _LEGAL_WORDS]
    if not any(w not in _TRADE_WORDS for w in words):
        return []  # nothing distinctive ("Plumbing Services LLC"): guesses would be someone else's
    stems = ["".join(words)]
    if "and" in words:
        stems.append("".join(w for w in words if w != "and"))
    out = [f"{s}{suffix}.com" for s in stems for suffix in ("", "tx", "dfw")] + [f"{stems[0]}.net"]
    return [d for d in dict.fromkeys(out) if len(d.split(".")[0]) <= 63]


def phones_on_page(page_html: str) -> set[str]:
    """Pure: every distinct 10-digit US number in visible text or tel: links."""
    text = html.unescape(_TAGS_RE.sub(" ", page_html))
    found = {"".join(m) for m in _PAGE_PHONE_RE.findall(text)}
    found |= {"".join(m) for m in _TEL_RE.findall(page_html)}
    return found


def is_own_site(page_html: str, phone: Optional[str]) -> bool:
    """Pure: the page shows the lead's phone and few other numbers (not a directory)."""
    want = _digits(phone)
    if len(want) != 10:
        return False
    nums = phones_on_page(page_html)
    return want in nums and len(nums) <= MAX_PHONES_OWN_SITE


class _PublicRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        p = urlparse(newurl)
        if p.scheme not in ("http", "https") or not _host_is_public(p.hostname or ""):
            return None  # refuse redirects into private space; urllib then raises
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_opener = urllib.request.build_opener(_PublicRedirects)


_BLOCKED = "blocked"  # _fetch_html sentinel: the host answered but refused a plain HTTP client
MAX_BROWSER_FALLBACKS = 2


def _fetch_html(url: str):
    """GET a public http(s) page. Returns the HTML, None (dead/not HTML), or
    _BLOCKED (403/429/5xx: usually Cloudflare refusing non-browser clients)."""
    p = urlparse(url)
    if p.scheme not in ("http", "https") or not _host_is_public(p.hostname or ""):
        return None
    req = urllib.request.Request(url, headers={"User-Agent": _UA, "Accept": "text/html,*/*;q=0.8"})
    try:
        with _opener.open(req, timeout=FETCH_TIMEOUT_S) as r:
            if "html" not in (r.headers.get("content-type") or ""):
                return None
            return r.read(1_500_000).decode(r.headers.get_content_charset() or "utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return _BLOCKED if exc.code in (403, 429) or exc.code >= 500 else None
    except Exception:  # noqa: BLE001 - dead site, TLS error, timeout
        return None


def _check_candidate(url: str, phone: str, try_http: bool):
    """(verdict, url): ("own", url), ("blocked", url) or (None, url)."""
    for u in (url, "http://" + url[len("https://"):]) if try_http else (url,):
        page = _fetch_html(u)
        if page == _BLOCKED:
            return _BLOCKED, u
        if page is not None:
            return ("own" if is_own_site(page, phone) else None), u
    return None, url


async def _allowed(url: str) -> bool:
    """Browser request filter: only http(s) to public IPs (plus inline data)."""
    p = urlparse(url)
    if p.scheme in ("data", "blob", "about"):
        return True
    return p.scheme in ("http", "https") and await asyncio.to_thread(_host_is_public, p.hostname or "")


async def _on_request(route) -> None:
    if await _allowed(route.request.url):
        await route.continue_()
    else:
        await route.abort("blockedbyclient")


async def _render_html(url: str) -> Optional[str]:
    """Load a page in Camoufox (passes most Cloudflare checks) in a throwaway
    tab of the browsing context, so an agent's browse/click page is untouched."""
    async with browser.lock:
        tab = await browser.browse_tab(_on_request)
        page = await tab.context.new_page()
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=12_000)
            await asyncio.sleep(2.5)  # let a JS challenge / client render finish
            return await page.content()
        except Exception:  # noqa: BLE001
            return None
        finally:
            await page.close()


def _search_hits_to_fetch(results: list[dict]) -> list[str]:
    """Homepages of non-directory, non-social search hits, one per host.

    The homepage, not the hit itself: an unlisted directory's profile page
    for this business shows only its phone (looks like an own site), but the
    directory's homepage doesn't. Own sites carry the phone site-wide.
    """
    out: list[str] = []
    seen: set[str] = set()
    for r in results:
        host = _host(r["href"])
        sld = host.split(".")[-2] if "." in host else host
        if not host or host in seen or sld in _DIRECTORY_SLDS or host.endswith(".gov"):
            continue
        seen.add(host)
        p = urlparse(_real_url(r["href"]))
        out.append(f"{p.scheme}://{p.netloc}/")
        if len(out) >= MAX_SEARCH_HITS_TO_FETCH:
            break
    return out


async def verify_sites(name: str, phone: Optional[str], results: list[dict]) -> tuple[list[dict], int]:
    """Fetch candidate pages in parallel; return (confirmed own sites, pages checked).

    Pages that refuse plain HTTP get one more try in the real browser (at most
    MAX_BROWSER_FALLBACKS per call, to stay inside the tool's timeout).
    """
    if len(_digits(phone)) != 10:
        return [], 0  # without a phone there is nothing to verify against
    jobs = [(u, "search", False) for u in _search_hits_to_fetch(results)]
    searched = {_host(u) for u, _, _ in jobs}
    jobs += [(f"https://{d}/", "guess", True) for d in guess_domains(name) if d not in searched]
    checked = await asyncio.gather(*(asyncio.to_thread(_check_candidate, u, phone, http) for u, _, http in jobs))
    own = [{"url": u, "matched": "phone_on_page", "via": via} for (v, u), (_, via, _) in zip(checked, jobs) if v == "own"]
    if not own:
        blocked = [(u, via) for (v, u), (_, via, _) in zip(checked, jobs) if v == _BLOCKED][:MAX_BROWSER_FALLBACKS]
        for u, via in blocked:
            page = await _render_html(u)
            if page and is_own_site(page, phone):
                own.append({"url": u, "matched": "phone_on_page", "via": via})
                break
    return own, len(jobs)


SEARCH_BLOCK_COOLDOWN_S = 600.0
_search_blocked_until = 0.0  # monotonic; while in the future, skip DuckDuckGo


async def web_presence(name: str, city: Optional[str] = None, phone: Optional[str] = None) -> dict:
    async def body() -> dict:
        global _search_blocked_until
        if not name or not name.strip():
            raise HarvestError("invalid_argument", reason="name is required")
        query = f'"{name.strip()}" {city or ""}'.strip()
        results: list[dict] = []
        blocked = time.monotonic() < _search_blocked_until
        if not blocked:
            async with browser.lock:
                page = await browser.page()
                await _check_live_selectors(page)
                await _pace()
                await page.goto("https://html.duckduckgo.com/html/?q=" + quote_plus(query), wait_until="domcontentloaded", timeout=30_000)
                guard.last_nav = time.monotonic()
                got = await page.evaluate(_JS_EXTRACT_SEARCH, SELECTORS)
            # A search-engine block says nothing about Maps: no challenge cooldown.
            blocked = bool(got["blocked"])
            if blocked:
                _search_blocked_until = time.monotonic() + SEARCH_BLOCK_COOLDOWN_S
            else:
                results = got["results"]
        # Blocked: domain guesses still work without the search.
        out = classify_presence(name, phone, results)
        out["pages_checked"] = 0
        out["search_blocked"] = blocked
        if out["verdict"] != "likely_has_website":
            # Name heuristic found nothing: check pages for the lead's phone.
            own, out["pages_checked"] = await verify_sites(name, phone, results)
            if own:
                confirmed = {_host(o["url"]) for o in own}
                rest = [c for c in out["candidate_websites"] if _host(c["url"]) not in confirmed]
                out["candidate_websites"] = (own + rest)[:3]
                out["verdict"] = "likely_has_website"
        return {"selector_version": SELECTOR_VERSION, "query": query, **out}

    return await _run(body)


# DFW centre; the city in the query does the real targeting.
_DEFAULT_CENTRE = (32.85, -96.95)


async def maps_lookup(name: str, city: Optional[str] = None, phone: Optional[str] = None,
                      lat: Optional[float] = None, lng: Optional[float] = None) -> dict:
    """Find one known business (e.g. from a licence roster) on Google Maps."""
    if not name or not name.strip():
        return error("invalid_argument", reason="name is required")
    query = " ".join(p for p in (name.strip(), city, "TX") if p)
    near = lat is not None and lng is not None
    r = await harvest_tile(query, lat if near else _DEFAULT_CENTRE[0], lng if near else _DEFAULT_CENTRE[1], 14 if near else 11, 5)
    if "error" in r:
        return r
    card, how = match_card(name, phone, r["results"])
    return {"selector_version": SELECTOR_VERSION, "query": query, "found": card is not None,
            "matched_by": how, "listing": card, "cards_checked": len(r["results"])}


def status() -> dict:
    refresh_selectors()
    return {
        "selector_version": SELECTOR_VERSION,
        "browser_alive": browser.alive,
        "config": dict(CONFIG),
        **guard.status(),
    }


async def shutdown() -> None:
    await browser.close()
