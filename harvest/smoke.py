"""Smoke test: one real harvest against Google Maps, printed as JSON.

    harvest/.venv/Scripts/python.exe harvest/smoke.py [category] [limit]
"""
import asyncio
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import maps_harvest  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")


async def main() -> None:
    category = sys.argv[1] if len(sys.argv) > 1 else "plumber"
    limit = int(sys.argv[2]) if len(sys.argv) > 2 else 50
    t0 = time.time()
    res = await maps_harvest.harvest_tile(category, 32.7767, -96.7970, 13, limit)  # downtown Dallas
    body = json.dumps(res, ensure_ascii=False)
    print(body)
    print(f"--- {len(body)} bytes, {time.time() - t0:.1f}s, results={len(res.get('results', []))}", file=sys.stderr)
    if res.get("results") and "--detail" in sys.argv:
        t1 = time.time()
        d = await maps_harvest.listing_detail(res["results"][0]["maps_url"])
        print(json.dumps(d, ensure_ascii=False))
        print(f"--- detail {time.time() - t1:.1f}s", file=sys.stderr)
        t2 = time.time()
        c = await maps_harvest.check_operating(res["results"][0]["maps_url"])
        print(json.dumps(c, ensure_ascii=False))
        print(f"--- check_operating {time.time() - t2:.1f}s", file=sys.stderr)
    await maps_harvest.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
