"""Offline check of the licence-roster parsers: python harvest/test_licenses.py"""
import os
import sys
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from licenses import license_leads, parse_tdlr, parse_tsbpe  # noqa: E402

TODAY = date(2026, 9, 26)
CSV = '''﻿"RANK","LICENSE_NBR","LIC_STATUS","EXPIRATION_DTE","LAST_NAME","FIRST_NAME","ADDR1","CITY","ZIP","PHONE","COUNTY","PLUMB_COMPANY"
"M","1","Current","11/30/2026","SAWYER","LARRY","601 CHISHOLM TR.","DENTON","76201","8173827464","DENTON","SAWYER PLUMBING SERVICE"
"M","2","Current","11/30/2026","DOE","JANE","1 A ST","DALLAS","75201","(817) 382-7464","DALLAS","DUPLICATE PHONE CO"
"M","3","Expired","11/30/2026","OLD","OLLIE","1 B ST","DALLAS","75201","2145550000","DALLAS","EXPIRED CO"
"M","4","Current","11/30/2026","NOPHONE","NED","1 C ST","DALLAS","75201","","DALLAS","NO PHONE CO"
"M","5","Current","11/30/2026","FAR","FRED","1 D ST","AUSTIN","78701","5125550000","TRAVIS","WRONG COUNTY CO"
"M","6","Current","11/30/2026","SOLO","SAM","1 E ST","PLANO","75074","9725550000","COLLIN",""
'''
r = parse_tsbpe(CSV, {"DALLAS", "DENTON", "COLLIN"}, TODAY)
assert [x["business_name"] for x in r] == ["SAWYER PLUMBING SERVICE", "Sam Solo"], r  # dup phone, expired, no phone, other county dropped
assert r[0]["phone"] == "8173827464" and r[0]["city"] == "Denton" and r[0]["zip"] == "76201"

items = [
    {"license_number": "1", "business_name": "ARROW ELECTRIC SERVICE", "business_telephone": "9729267007",
     "business_city_state_zip": "GARLAND TX 75041-2338", "business_county": "DALLAS",
     "license_expiration_date_mmddccyy": "11/12/2026", "business_mailing": {"type": "Point", "coordinates": [-96.63655, 32.91427]}},
    {"license_number": "2", "business_name": "EXPIRED LLC", "business_telephone": "9725550001",
     "license_expiration_date_mmddccyy": "06/30/2025"},
    {"license_number": "3", "business_name": "OWNER PHONE ONLY", "owner_telephone": "214-555-0002",
     "license_expiration_date_mmddccyy": "01/01/2027"},
]
r = parse_tdlr(items, "electrician", TODAY)
assert [x["license_number"] for x in r] == ["1", "3"], r
assert (r[0]["city"], r[0]["zip"], r[0]["lat"], r[0]["lng"]) == ("Garland", "75041", 32.91427, -96.63655), r[0]
assert r[1]["phone"] == "2145550002"

# Input validation happens before any network call.
assert license_leads("roofer")["error"] == "invalid_argument"
assert license_leads("hvac")["error"] == "invalid_argument"
assert license_leads("electrician", "DALLAS') OR (1=1")["error"] == "invalid_argument"
print("ok")
