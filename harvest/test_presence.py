"""Offline check of the web_presence classifier: python harvest/test_presence.py"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from maps_harvest import _search_hits_to_fetch, classify_presence, guess_domains, is_own_site, match_card, phones_on_page  # noqa: E402

ddg = lambda url: "https://duckduckgo.com/l/?uddg=" + url.replace(":", "%3A").replace("/", "%2F") + "&rut=x"

# Own site found by name in domain; directories and socials never count as a website.
r = classify_presence("Smith Plumbing LLC", "(214) 555-0101", [
    {"href": ddg("https://www.yelp.com/biz/smith-plumbing"), "title": "Smith Plumbing - Yelp", "snippet": "Call (214) 555-0101"},
    {"href": ddg("https://www.facebook.com/smithplumbingtx"), "title": "Smith Plumbing", "snippet": "info@smithplumbing.com"},
    {"href": ddg("https://smith-plumbing-tx.com/"), "title": "Home", "snippet": ""},
])
assert r["verdict"] == "likely_has_website", r
assert r["candidate_websites"][0] == {"url": "https://smith-plumbing-tx.com/", "matched": "name"}, r
assert r["facebook"] == "https://www.facebook.com/smithplumbingtx"
assert r["emails"] == ["info@smithplumbing.com"]
assert r["phone_seen_online"] is True

# Trade words alone don't match; a phone-only hit is listed for review but doesn't
# flip the verdict (it's usually an unlisted directory, e.g. cityof.com on J & K Plumbing).
r = classify_presence("Quality Plumbing", "2145550199", [
    {"href": ddg("https://bestplumbing.com/"), "title": "Best Plumbing", "snippet": ""},
    {"href": ddg("https://qp-dfw.com/"), "title": "QP", "snippet": "Call 214.555.0199 today"},
])
assert r["candidate_websites"] == [{"url": "https://qp-dfw.com/", "matched": "phone"}], r
assert r["verdict"] == "no_website_found", r

# Only directories -> no website; nothing at all -> unknown.
assert classify_presence("Acme Roofing", None, [{"href": ddg("https://www.bbb.org/x"), "title": "", "snippet": ""}])["verdict"] == "no_website_found"
assert classify_presence("Acme Roofing", None, [])["verdict"] == "unknown"
# Two pages of one site -> one candidate.
two = [{"href": u, "title": "", "snippet": ""} for u in ("https://acmeroof.com/", "https://acmeroof.com/about")]
assert len(classify_presence("Acme Roofing", None, two)["candidate_websites"]) == 1
# 'x' is a directory SLD only as exactly x.com.
assert classify_presence("Fox Electric", None, [{"href": "https://foxelectric.com/", "title": "", "snippet": ""}])["verdict"] == "likely_has_website"
# 2-letter names match only as the start of the domain (real miss: SK Electric).
sk = lambda u: classify_presence("SK ELECTRIC INC", None, [{"href": u, "title": "", "snippet": ""}])["verdict"]
assert sk("https://skelectric.com/") == "likely_has_website"
assert sk("https://desk-tasks.com/") == "no_website_found"

# match_card, from real Maps searches on licence-roster names (2026-09-26).
cards = [{"name": "Smith Plumbing Company", "phone": "(972) 573-1634"}, {"name": "All Masters Plumbing", "phone": "(214) 396-0270"}]
assert match_card("ROLFE PLUMBING", None, cards) == (None, None)            # Maps showed other plumbers
assert match_card("DEAN ELECTRIC, INC", None, [{"name": "Dean Electric Inc", "phone": "+19722917153"}])[1] == "name"
assert match_card("SK ELECTRIC INC", None, [{"name": "SK Electric, Inc.", "phone": None}])[1] == "name"
assert match_card("B & D PLUMBING SERVICES LLC", "2143960270", cards) == (cards[1], "phone")  # no distinctive words: phone only
assert match_card("B & D PLUMBING SERVICES LLC", None, cards) == (None, None)
# guess_domains: legal suffixes dropped, "&" -> both "and" and nothing, trade words kept.
g = guess_domains("Joe's Plumbing LLC")
assert g[:3] == ["joesplumbing.com", "joesplumbingtx.com", "joesplumbingdfw.com"] and "joesplumbing.net" in g, g
g = guess_domains("B & D PLUMBING SERVICES LLC")
assert "banddplumbingservices.com" in g and "bdplumbingservices.com" in g, g
assert guess_domains("Plumbing Services LLC") == []   # nothing distinctive: would hit strangers

# phones_on_page: visible text + tel: links; scripts/styles and long digit runs ignored.
page = """<html><script>var id=2145550101999; var t="972-555-0000";</script>
<a href="tel:+1-214-555-0101">Call us</a> <p>(469) 555&#8209;0102</p> <p>Order #12145550103</p></html>"""
assert phones_on_page(page) == {"2145550101", "4695550102"}, phones_on_page(page)

# is_own_site: lead's phone present and few numbers overall; directories have many.
assert is_own_site(page, "(214) 555-0101")
assert not is_own_site(page, "2145559999")
assert not is_own_site(page, None)
directory = "".join(f"<li>Plumber {i}: (214) 555-01{i:02d}</li>" for i in range(12))
assert not is_own_site(directory, "2145550101")

# Only non-directory hits get fetched, once per host.
hits = _search_hits_to_fetch([{"href": ddg(u)} for u in (
    "https://www.yelp.com/biz/x", "https://jkplumb.com/", "https://jkplumb.com/contact", "https://www.dallas.gov/x", "https://other.net/")])
assert hits == ["https://jkplumb.com/", "https://other.net/"], hits
# Deep links (directory profile pages, real miss: findglocal on Atlas Plumbing) -> homepage.
assert _search_hits_to_fetch([{"href": "https://www.findglocal.com/US/Fort-Worth/1045/Atlas-Plumbing"}]) == ["https://www.findglocal.com/"]
# DBA: guess from the trade name (real miss: garysqualityplumbing.com).
assert guess_domains("DOROTHY C SKINNER DBA GARY'S QUALITY PLUMBING")[0] == "garysqualityplumbing.com"
assert guess_domains("AABC PLUMBING INC (DBA: ABC PLUMBING)")[0] == "abcplumbing.com"
print("ok")
