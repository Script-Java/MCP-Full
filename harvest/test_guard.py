"""Offline check of the call budget and circuit breaker: python harvest/test_guard.py"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import maps_harvest as mh  # noqa: E402

now = [1000.0]
mh.time.monotonic = lambda: now[0]
mh.CONFIG.update(max_calls=3, budget_window_s=100.0, max_consecutive_empty=2, circuit_reset_s=50.0)
g = mh.Guard()

# Budget: 3 calls per rolling 100 s.
for _ in range(3):
    assert g.check() is None
    g.count_call()
    now[0] += 10
e = g.check()
assert e["error"] == "budget_exhausted" and e["calls"] == 3 and e["retry_after_s"] == 71, e
now[0] = 1100.5  # first call (t=1000) has left the window
assert g.check() is None and g.calls == 2
assert g.status()["calls"] == 2

# Circuit: opens after 2 empty harvests, closes 50 s later; any hit resets it.
g = mh.Guard()
g.note_result(0)
g.note_result(5)
g.note_result(0)
assert g.check() is None
g.note_result(0)
e = g.check()
assert e["error"] == "circuit_open" and e["retry_after_s"] == 50, e
assert g.status()["circuit_open"] is True
now[0] += 49
assert g.check()["error"] == "circuit_open"
now[0] += 1
assert g.check() is None and g.consecutive_empty == 0 and g.status()["circuit_open"] is False
g.note_result(0)
assert g.check() is None  # one empty after closing is not enough to reopen

print("guard ok")
