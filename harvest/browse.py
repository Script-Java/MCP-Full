"""browse.py - general web browsing on the harvester's Camoufox.

Unlike maps_harvest (which never returns page text), these tools hand the
agent readable page text, links and form fields. That text is untrusted web
content. Browsing uses its own browser context, so it shares the Camoufox
fingerprint and the home IP with Maps but not cookies or page state, and it
skips the Maps budget/circuit breaker/cooldown.

Every request in the browsing context (navigations, redirects, subresources,
popups) is routed through `_on_request`, which only lets http(s) traffic to
public IPs through. This process runs on a home network; without that check a
page or a prompt-injected agent could reach the router, the LAN or this
server's own HTTP port.
"""
from __future__ import annotations

import asyncio
import re
from typing import Optional
from urllib.parse import urlparse

from maps_harvest import HarvestError, _allowed, _host_is_public, _on_request, _run, browser

MAX_CHARS_DEFAULT = 6000
MAX_CHARS_CAP = 20000

_BLOCK_RE = re.compile(r"just a moment|verify you are (a )?human|captcha|access denied|unusual traffic|are you a robot", re.I)

_JS_SUMMARY = r"""
([maxChars, withLinks]) => {
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const text = (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n').trim();
  const out = { title: document.title, text: text.slice(0, maxChars), text_truncated: text.length > maxChars, fields: [] };
  for (const el of document.querySelectorAll('input:not([type=hidden]):not([type=submit]), textarea, select')) {
    const label = clean((el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute('aria-label') || el.placeholder || el.name || el.id);
    if (label) out.fields.push({ field: label.slice(0, 60), type: el.type || el.tagName.toLowerCase() });
    if (out.fields.length >= 20) break;
  }
  if (withLinks) {
    const seen = new Set(); out.links = [];
    for (const a of document.querySelectorAll('a[href]')) {
      if (!/^https?:/.test(a.href) || seen.has(a.href)) continue;
      seen.add(a.href);
      out.links.push({ text: clean(a.innerText || a.getAttribute('aria-label')).slice(0, 80), href: a.href });
      if (out.links.length >= 60) break;
    }
  }
  return out;
}
"""


async def _check_url(url: str) -> None:
    p = urlparse(url or "")
    if p.scheme not in ("http", "https") or not p.hostname:
        raise HarvestError("invalid_argument", reason="url must be an absolute http(s) URL")
    if not await _allowed(url):
        raise HarvestError("blocked_url", reason="private, local or unresolvable address")


async def _settle(page) -> None:
    try:
        await page.wait_for_load_state("domcontentloaded", timeout=10_000)
    except Exception:  # noqa: BLE001 - slow page; read whatever rendered
        pass
    await asyncio.sleep(0.8)  # let client-side rendering catch up


def _adopt_popup(page):
    """A click that opened a new tab: continue in the newest page."""
    pages = [p for p in page.context.pages if not p.is_closed()]
    if len(pages) > 1:
        browser.tab = pages[-1]
    return browser.tab


async def _summary(page, max_chars: int, links: bool) -> dict:
    n = max(500, min(int(max_chars or MAX_CHARS_DEFAULT), MAX_CHARS_CAP))
    got = await page.evaluate(_JS_SUMMARY, [n, bool(links)])
    got["possibly_blocked"] = bool(_BLOCK_RE.search(f"{got['title']} {got['text'][:2000]}"))
    return {"url": page.url, **got}


async def _find(page, target: str):
    """Resolve `target` as link/button text, label, placeholder, visible text, then CSS."""
    cands = [
        lambda: page.get_by_role("link", name=target),
        lambda: page.get_by_role("button", name=target),
        lambda: page.get_by_label(target),
        lambda: page.get_by_placeholder(target),
        lambda: page.locator(f'[name="{target}"]') if re.fullmatch(r"[\w\-\[\]]+", target) else None,
        lambda: page.get_by_text(target),
        lambda: page.locator(target),
    ]
    for make in cands:
        try:
            loc = make()
            if loc is not None and await loc.count():
                return loc.first
        except Exception:  # noqa: BLE001 - e.g. target is not valid CSS
            continue
    raise HarvestError("not_found", target=target)


async def browse(url: str, max_chars: int = MAX_CHARS_DEFAULT, links: bool = False) -> dict:
    async def body() -> dict:
        await _check_url(url)
        async with browser.lock:
            page = await browser.browse_tab(_on_request)
            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=30_000)
            except Exception as exc:  # noqa: BLE001
                raise HarvestError("navigation_failed", reason=str(exc).splitlines()[0][:200]) from None
            await _settle(page)
            return await _summary(page, max_chars, links)

    return await _run(body, guarded=False)


async def click(target: str, max_chars: int = MAX_CHARS_DEFAULT, links: bool = False) -> dict:
    async def body() -> dict:
        if not target or not target.strip():
            raise HarvestError("invalid_argument", reason="target is required")
        async with browser.lock:
            page = browser.tab
            if page is None or page.is_closed():
                raise HarvestError("no_page", reason="call browse first")
            await (await _find(page, target.strip())).click(timeout=10_000)
            await _settle(page)
            page = _adopt_popup(page)
            await _settle(page)
            return await _summary(page, max_chars, links)

    return await _run(body, guarded=False)


async def fill(field: str, value: str, submit: bool = False, max_chars: int = MAX_CHARS_DEFAULT) -> dict:
    async def body() -> dict:
        if not field or not field.strip():
            raise HarvestError("invalid_argument", reason="field is required")
        async with browser.lock:
            page = browser.tab
            if page is None or page.is_closed():
                raise HarvestError("no_page", reason="call browse first")
            loc = await _find(page, field.strip())
            await loc.fill(value or "", timeout=10_000)
            if submit:
                await loc.press("Enter")
                await _settle(page)
            return await _summary(page, max_chars, False)

    return await _run(body, guarded=False)


if __name__ == "__main__":  # offline self-check of the address filter
    assert not _host_is_public("localhost")
    assert not _host_is_public("127.0.0.1")
    assert not _host_is_public("192.168.1.1")
    assert not _host_is_public("10.0.0.5")
    assert not _host_is_public("169.254.169.254")
    assert not _host_is_public("100.100.100.100")  # CGNAT / Tailscale
    assert not _host_is_public("::1")
    assert not _host_is_public("")
    assert _host_is_public("8.8.8.8")
    assert not asyncio.run(_allowed("file:///C:/Windows/win.ini"))
    assert not asyncio.run(_allowed("http://127.0.0.1:8765/mcp"))
    assert asyncio.run(_allowed("data:text/plain,hi"))
    print("browse self-check ok")
