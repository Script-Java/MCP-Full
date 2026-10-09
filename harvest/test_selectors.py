"""Offline check of live selectors and extended cards: python harvest/test_selectors.py"""
import asyncio
import json
import os
import sys
import tempfile
import time

tmp = tempfile.mkdtemp()
FILE = os.path.join(tmp, "active-selectors.json")
os.environ["HARVEST_SELECTORS_FILE"] = FILE
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import maps_harvest as mh  # noqa: E402

BUILTIN = mh._BUILTIN_VERSION


def write(obj) -> None:
    with open(FILE, "w", encoding="utf-8") as fh:
        fh.write(obj if isinstance(obj, str) else json.dumps(obj))
    t = time.time() + write.n  # distinct mtime each write
    write.n += 1
    os.utime(FILE, (t, t))


write.n = 1

# Key mapping: website_btn -> card_website; rating ignored; unknown keys ignored.
m = mh.merge_selectors({"feed": "div.feed2", "website_btn": "a.web2", "rating": "span.MW4etd", "nope": "x"})
assert m["feed"] == "div.feed2" and m["card_website"] == "a.web2", m
assert m["card_rating"] == mh._BUILTIN_SELECTORS["card_rating"]
assert "nope" not in m and "website_btn" not in m
for bad in ({"feed": ""}, {"feed": 5}, {"feed": "a\nb"}, {"end_of_list_text": "(unclosed"}, ["feed"]):
    try:
        mh.merge_selectors(bad)
    except ValueError:
        pass
    else:
        raise AssertionError(f"accepted {bad}")

# No file: built-ins.
mh.refresh_selectors()
assert mh.SELECTOR_VERSION == BUILTIN

# Table copy: applied, version follows the table.
write({"version": "2026-09-14.1", "selectors": {"card": 'div[role="article"]', "website_btn": 'a[data-value="Website"]'}})
mh.refresh_selectors()
assert mh.SELECTOR_VERSION == "2026-09-14.1" and mh.SELECTORS["card"] == 'div[role="article"]'
assert mh.status()["selector_version"] == "2026-09-14.1"
assert mh.error("timeout")["selector_version"] == "2026-09-14.1"

# Broken file or bad value: back to built-ins.
write("{not json")
mh.refresh_selectors()
assert mh.SELECTOR_VERSION == BUILTIN and mh.SELECTORS == mh._BUILTIN_SELECTORS
write({"version": "2026-09-15.1", "selectors": {"end_of_list_text": "(oops"}})
mh.refresh_selectors()
assert mh.SELECTOR_VERSION == BUILTIN


# In-page CSS check rejects a version once and keeps it rejected.
class FakePage:
    def __init__(self, bad):
        self.bad = bad

    async def evaluate(self, _js, sels):
        return [k for k in sels if k in self.bad]


write({"version": "2026-09-16.1", "selectors": {"card": "div[[["}})
mh.refresh_selectors()
assert mh.SELECTOR_VERSION == "2026-09-16.1"
asyncio.run(mh._check_live_selectors(FakePage({"card"})))
assert mh.SELECTOR_VERSION == BUILTIN and "2026-09-16.1" in mh._live["rejected"]
write({"version": "2026-09-16.1", "selectors": {"card": "div[[["}})
mh.refresh_selectors()
assert mh.SELECTOR_VERSION == BUILTIN

# A good version passes the check and stays.
write({"version": "2026-09-17.1", "selectors": {"card": "div.ok"}})
mh.refresh_selectors()
asyncio.run(mh._check_live_selectors(FakePage(set())))
assert mh.SELECTOR_VERSION == "2026-09-17.1" and mh._live["checked"]

# File removed: built-ins.
os.remove(FILE)
mh.refresh_selectors()
assert mh.SELECTOR_VERSION == BUILTIN

# Extended card fields: detail-page cards get the pin from the URL; stripped by default.
card = mh._card_from_detail(
    {"name": "X", "rating": 4.5, "review_count": 3, "website_url": None, "address": "1 Main St", "phone": "214",
     "category_label": "Plumber", "permanently_closed": False, "temporarily_closed": True},
    "https://www.google.com/maps/place/X/@33.1,-96.9,14z/data=!3m1!4b1!4m6!3m5!1s0x864c:0x1a2b!8m2!3d33.2523966!4d-97.1083496",
)
assert (card["maps_cid"], card["lat"], card["lng"], card["closed"]) == ("6699", 33.2523966, -97.1083496, True), card
assert set(mh._strip_extended([card])[0]) == {"name", "maps_cid", "maps_url", "rating", "review_count", "has_website",
                                              "website_url", "sponsored", "address_line", "phone", "category_label"}

print("selectors ok")
