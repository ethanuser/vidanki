#!/usr/bin/env python3
"""VidAnki: watch B&B / Sketchy videos in dark mode, then do their Anki cards.

Run:  python3 server.py            (http://localhost:8770)
      python3 server.py --lan      (also reachable from phone on the same network)
"""
import argparse
import datetime as dt
import json
import mimetypes
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BLOCKS_DIR = ROOT / "blocks"
DATA_DIR = ROOT / "data"
STATIC_DIR = ROOT / "static"

# Machine-specific settings live in local.json (not committed); see local.example.json.
LOCAL = json.loads((ROOT / "local.json").read_text()) if (ROOT / "local.json").exists() else {}
ANKI_URL = LOCAL.get("ankiConnectUrl", "http://127.0.0.1:8766")
ANKI_PROFILE_DIR = Path(LOCAL.get("ankiProfileDir", "~/Library/Application Support/Anki2/User 1")).expanduser()
FILTERED_DECK = "VidAnki"
HY_TAGS = [
    "#AK_Step1_v12::#Low/HighYield::1-HighYield",
    "#AK_Step1_v12::#Low/HighYield::2-RelativelyHighYield",
    "#AK_Step1_v12::#Low/HighYield::3-HighYield-temporary",
]
DAY_ROLLOVER_HOUR = 4  # same as Anki: studying at 1am counts for the previous day

# Priors for time estimates; blended with what you actually take (see estimates()).
# Your time per minute of video (pauses, rewinds, notes), by source.
PRIOR_VIDEO_FACTOR = {"bnb": 1.5, "sketchy": 2.0}
PRIOR_VIDEO_WEIGHT = 3 * 3600  # seconds of video the prior is "worth"; the tracker can miss long pauses
# Anki cards. Anki's log only covers time until you press a button, so your
# real time is higher: your log shows ~27 s per new card on its first day vs.
# ~70 s you actually spend (reading the extra, re-reviewing).
PRIOR_NEW_CARD_SEC = 70
PRIOR_CARD_WEIGHT = 50
REVLOG_OVERHEAD = 70 / 27
REVIEW_SEC = 35  # mix of ~25 s familiar and ~70 s shaky cards
FRESH_REVIEWS_PER_CARD_10D = 1.16  # measured: reviews a new card gets in its first 10 days
PRIOR_BRICK_SEC = 8 * 60
PRIOR_BRICK_WEIGHT = 2
PRIOR_AMBOSS_SEC_PER_Q = 4 * 60  # ~1.5 min answering + ~2.5 min reading the explanation
PRIOR_AMBOSS_WEIGHT = 20

mimetypes.add_type("video/mp4", ".m4v")
mimetypes.add_type("video/x-matroska", ".mkv")

lock = threading.RLock()


# ---------- persistence ----------

def load_json(path, default):
    try:
        return json.loads(Path(path).read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_json(path, obj):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=1))
    os.replace(tmp, path)


STATE_PATH = DATA_DIR / "state.json"
CACHE_PATH = DATA_DIR / "cache.json"

state = load_json(STATE_PATH, {})
state.setdefault("items", {})
state.setdefault("batches", [])
state.setdefault("days", {})
state.setdefault("settings", {"rate": 1.0, "dark": {}})
cache = load_json(CACHE_PATH, {})
cache.setdefault("durations", {})
cache.setdefault("cardCounts", {})
if any(isinstance(v, int) for c in cache["cardCounts"].values() for v in c.values()):
    cache["cardCounts"] = {}  # old format (before tiers)
cache.setdefault("ankiByDay", {})
if "claimed" not in cache:
    cache["cardCounts"] = {}  # recount once so cards already in your decks aren't double-counted


def save_state():
    save_json(STATE_PATH, state)


def save_cache():
    save_json(CACHE_PATH, cache)


def study_day(ts=None):
    t = dt.datetime.fromtimestamp(ts or time.time()) - dt.timedelta(hours=DAY_ROLLOVER_HOUR)
    return t.date().isoformat()


def item_state(item_id):
    return state["items"].setdefault(item_id, {})


def peek_state(item_id):
    return state["items"].get(item_id, {})


def add_day_time(kind, seconds, ts=None):
    day = state["days"].setdefault(study_day(ts), {})
    day[kind] = day.get(kind, 0) + seconds


# ---------- blocks ----------

def load_blocks():
    blocks = {}
    for p in sorted(BLOCKS_DIR.glob("*.json")):
        b = json.loads(p.read_text())
        # roots look like "{bnb}/18.Pulmonary"; {bnb} etc. come from local.json "bases"
        b["roots"] = {k: str(Path(v.format(**LOCAL.get("bases", {}))).expanduser()) for k, v in b["roots"].items()}
        prefixes = b.get("tagPrefixes", {})
        for cluster in b["clusters"]:
            for it in cluster["items"]:
                it["cluster"] = cluster["title"]
                tags = []
                for t in it.get("tags", []):
                    for short, full in prefixes.items():
                        if t.startswith(short):
                            t = full + t[len(short):]
                            break
                    tags.append(t)
                it["tags"] = tags
        blocks[b["id"]] = b
    return blocks


BLOCKS = load_blocks()


def goal_date(block):
    return state["settings"].get("goalDates", {}).get(block["id"], block["goalDate"])


def find_item(block, item_id):
    for cluster in block["clusters"]:
        for it in cluster["items"]:
            if it["id"] == item_id:
                return it
    raise KeyError(item_id)


def all_items(block):
    return [it for c in block["clusters"] for it in c["items"]]


def video_paths(block, item):
    """(plain path, underscored path) for a video item."""
    p = Path(block["roots"][item["source"]]) / item["file"]
    return p, p.with_name("_" + p.name)


def resolve_video(block, item):
    """Return (existing path or None, done flag). Done == file name starts with '_'."""
    plain, under = video_paths(block, item)
    if under.exists():
        return under, True
    if plain.exists():
        return plain, False
    return None, False


def is_done(block, item):
    if item["type"] == "video":
        path, done = resolve_video(block, item)
        if path is not None:
            return done
    return bool(peek_state(item["id"]).get("done", item.get("done", False)))


def duration(block, item):
    key = f'{block["id"]}/{item["id"]}'
    if key in cache["durations"]:
        return cache["durations"][key]
    path, _ = resolve_video(block, item)
    if path is None:
        return 0
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
            capture_output=True, text=True, timeout=20,
        ).stdout.strip()
        d = float(out)
    except (ValueError, subprocess.SubprocessError, FileNotFoundError):
        return 0
    cache["durations"][key] = d
    save_cache()
    return d


# ---------- Anki ----------

class AnkiError(Exception):
    pass


_anki_ok = {"t": 0, "ok": False}


def anki(action, timeout=10, **params):
    body = json.dumps({"action": action, "version": 6, "params": params}).encode()
    req = urllib.request.Request(ANKI_URL, body, {"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            resp = json.loads(r.read())
    except Exception as e:  # connection refused, timeout, bad JSON
        _anki_ok.update(t=time.time(), ok=False)
        raise AnkiError(f"Anki not reachable ({e.__class__.__name__}). Is Anki open?") from e
    _anki_ok.update(t=time.time(), ok=True)
    if resp.get("error"):
        raise AnkiError(resp["error"])
    return resp.get("result")


def anki_reachable():
    if time.time() - _anki_ok["t"] < 5:
        return _anki_ok["ok"]
    try:
        anki("version", timeout=1.5)
    except AnkiError:
        pass
    return _anki_ok["ok"]


def q(tag):
    return '"tag:' + tag.replace('"', '\\"') + '"'


TIERS = {"1": HY_TAGS[0], "2": HY_TAGS[1], "3": HY_TAGS[2]}


def selected_tiers():
    return [t for t in state["settings"].get("tiers", list(TIERS)) if t in TIERS] or ["1"]


def hy_query(tiers=None):
    return "(" + " OR ".join(q(TIERS[t]) for t in (tiers or selected_tiers())) + ")"


def item_query(item, tiers=None):
    return f'{hy_query(tiers)} ({" OR ".join(q(t) for t in item["tags"])})'


def count_cards(combos, tiers=None):
    """combos maps a tier combination like "13" to a card count."""
    tiers = tiers or selected_tiers()
    return sum(n for combo, n in (combos or {}).items() if any(t in combo for t in tiers))


def _store_counts(block, item_cards, tier_of, source):
    """item_cards: item id -> card ids still suspended/new; tier_of: card id -> combo.

    "own" counts every card an item would unsuspend (shown on its button);
    "excl" gives each card only to the first pending item that covers it, so
    shared cards (e.g. B&B Pneumonia vs. Sketchy S. pneumo) aren't counted twice.
    """
    counts, claimed = {}, set()
    for it in all_items(block):
        cids = item_cards.get(it["id"])
        if cids is None:
            continue
        own, excl = {}, {}
        pending = not is_done(block, it)
        for cid in cids:
            combo = tier_of.get(cid)
            if not combo:
                continue
            own[combo] = own.get(combo, 0) + 1
            if pending and cid not in claimed:
                claimed.add(cid)
                excl[combo] = excl.get(combo, 0) + 1
        counts[it["id"]] = {"own": own, "excl": excl}
    cache["cardCounts"][block["id"]] = counts
    # remember which card goes with a remaining item, so cards already sitting in
    # your decks aren't counted twice (see refresh_reviews_due)
    cache.setdefault("claimed", {})[block["id"]] = {str(c): tier_of.get(c, "") for c in claimed}
    cache["cardCountsSource"] = source
    save_cache()


def refresh_card_counts_from_anki(block):
    avail = "(is:suspended OR is:new)"
    per_tier = {t: set(anki("findCards", query=f"{q(tag)} {avail}")) for t, tag in TIERS.items()}
    item_cards = {}
    for it in all_items(block):
        if it.get("tags"):
            item_cards[it["id"]] = anki("findCards", query=f"{item_query(it, list(TIERS))} {avail}")
    tier_of = {}
    for cids in item_cards.values():
        for cid in cids:
            tier_of[cid] = "".join(t for t in TIERS if cid in per_tier[t])
    _store_counts(block, item_cards, tier_of, "Anki")


def refresh_card_counts_from_sqlite(block):
    """Fallback when Anki is closed: read a copy of the collection directly."""
    col = ANKI_PROFILE_DIR / "collection.anki2"
    if not col.exists():
        return
    with tempfile.TemporaryDirectory() as td:
        dst = Path(td) / "c.db"
        shutil.copy(col, dst)
        if col.with_name("collection.anki2-wal").exists():
            shutil.copy(col.with_name("collection.anki2-wal"), Path(td) / "c.db-wal")
        db = sqlite3.connect(dst)
        db.create_collation("unicase", lambda a, b: (a.lower() > b.lower()) - (a.lower() < b.lower()))
        rows = db.execute(
            "select c.id, n.tags, c.queue, c.type from cards c join notes n on c.nid = n.id "
            "where n.tags like '%HighYield%'"
        ).fetchall()
        db.close()
    tier_tags = {t: tag.lower() for t, tag in TIERS.items()}

    def has(tags, tag):
        tag = tag.lower()
        return any(t == tag or t.startswith(tag + "::") for t in tags)

    parsed, tier_of = [], {}
    for cid, tags, queue, ctype in rows:
        ts = tags.lower().split()
        combo = "".join(t for t, tag in tier_tags.items() if tag in ts)
        if combo and (queue == -1 or ctype == 0):
            parsed.append((cid, ts))
            tier_of[cid] = combo
    item_cards = {}
    for it in all_items(block):
        if it.get("tags"):
            item_cards[it["id"]] = [cid for cid, ts in parsed if any(has(ts, t) for t in it["tags"])]
    _store_counts(block, item_cards, tier_of, "the collection file (Anki closed)")


def refresh_reviews_due(block):
    """What's already waiting in Anki (your whole collection, not just VidAnki's deck):
    reviews scheduled before the goal date, reviews due today, and new cards that
    are unsuspended but not tied to a remaining item (e.g. ones you unsuspended yourself)."""
    days = max((dt.date.fromisoformat(goal_date(block)) - dt.date.fromisoformat(study_day())).days, 0)
    n = len(anki("findCards", query=f"-is:new -is:suspended prop:due<={days}"))
    due_today = len(anki("findCards", query="is:due -is:suspended"))
    claimed = cache.get("claimed", {}).get(block["id"], {})
    tiers = selected_tiers()
    waiting = [c for c in anki("findCards", query=f'is:new -is:suspended -"deck:{FILTERED_DECK}"')
               if not any(t in claimed.get(str(c), "") for t in tiers)]
    cache.setdefault("reviewsDue", {})[block["id"]] = {
        "n": n, "dueToday": due_today, "waitingNew": len(waiting), "through": goal_date(block), "at": time.time()}


REVIEW_DECK = LOCAL.get("reviewDeck", "AnKing Step Deck")
ANKI_ROW_MIN_SEC = 10 * 60  # below this, the queue's Anki row hides (stragglers aren't worth a row)


def refresh_deck_now():
    """What's studyable in the VidAnki deck right now."""
    deck = f'"deck:{FILTERED_DECK}"'
    cache["deckNow"] = {
        "due": len(anki("findCards", query=f"{deck} is:due -is:new")),
        "new": len(anki("findCards", query=f"{deck} is:new")),
        "at": time.time(),
    }


def rebuild_filtered_deck():
    """VidAnki deck = new cards from finished videos + (optionally) reviews due today
    in your AnKing deck, so everything can be studied from one place. Reviews done
    here count as normal reviews (the deck reschedules)."""
    # Gathered in two passes so the deck studies in a sensible order:
    # 1) cards already studied (reviews, learning) by due date, most overdue first;
    # 2) new cards from finished videos in deck order, which follows B&B order.
    open_cids = sorted({c for b in state["batches"] if not b.get("closed") for c in b.get("cids", [])})
    seen = []
    if state["settings"].get("reviewsInDeck", True):
        seen.append(f'("deck:{REVIEW_DECK}" is:due -is:new -is:suspended)')
    if open_cids:
        seen.append(f'(cid:{",".join(map(str, open_cids))} is:learn)')
    terms = []
    if seen:
        terms.append({"search": " OR ".join(seen), "order": "DUE"})
    if open_cids:
        terms.append({"search": f'cid:{",".join(map(str, open_cids))} is:new', "order": "DUE"})
    state["deckBuiltDay"] = study_day()
    if not terms:
        anki("vidankiEmptyFilteredDeck", name=FILTERED_DECK)
        return 0
    try:
        try:
            res = anki("vidankiFilteredDeck", name=FILTERED_DECK, terms=terms)
            state["deckFallback"] = False
        except AnkiError as e:
            if "terms" not in str(e):
                raise
            # bridge add-on not reloaded yet (Anki needs a restart): one combined search;
            # the worker rebuilds properly once Anki comes back after a restart
            res = anki("vidankiFilteredDeck", name=FILTERED_DECK, search=" OR ".join(f"({t['search']})" for t in terms))
            state["deckFallback"] = True
    except AnkiError as e:
        if "no cards" in str(e).lower() or "matched" in str(e).lower():  # nothing to study yet
            anki("vidankiEmptyFilteredDeck", name=FILTERED_DECK)
            return 0
        raise
    return res["cards"]


def process_batch(block, batch):
    """Unsuspend HY cards for a finished item and put its new cards in the filtered deck."""
    item = find_item(block, batch["itemId"])
    suspended = anki("findCards", query=f"{item_query(item)} is:suspended")
    if suspended:
        anki("unsuspend", cards=suspended)
    new = anki("findCards", query=f"{item_query(item)} is:new -is:suspended")
    batch.update(unsuspended=len(suspended), cids=new, needsAnki=False, processedAt=time.time())
    if not new:
        batch["closed"] = True
    try:
        rebuild_filtered_deck()
        batch["deckError"] = None
    except AnkiError as e:
        # Most likely the bridge add-on is not loaded (Anki not restarted yet).
        batch["deckError"] = str(e)


def process_pending_batches(block):
    changed = False
    for b in state["batches"]:
        if b.get("needsAnki") and b["block"] == block["id"]:
            process_batch(block, b)
            changed = True
    if changed:
        save_state()
        refresh_card_counts_from_anki(block)


def refresh_batches():
    """Update new/learning counts and review time for open batches."""
    for b in state["batches"]:
        if b.get("needsAnki") or not b.get("cids"):
            continue
        if b.get("closed") and b.get("reviewsFinal"):
            continue
        cids = b["cids"]
        info = [c for c in anki("cardsInfo", cards=cids) if c["queue"] != -1]  # suspended cards don't block
        b["newLeft"] = sum(1 for c in info if c["type"] == 0)
        b["learning"] = sum(1 for c in info if c["type"] in (1, 3))
        reviews = anki("getReviewsOfCards", cards=[str(c) for c in cids])
        since_ms = b["createdAt"] * 1000
        per_day = {}
        studied = 0
        first_day = 0
        for revs in reviews.values():
            mine = [r for r in revs if r["id"] >= since_ms]
            if mine:
                studied += 1
                start = min(r["id"] for r in mine)
                first_day += sum(r["time"] for r in mine if r["id"] - start < 12 * 3600 * 1000) / 1000
            for r in mine:
                d = study_day(r["id"] / 1000)
                per_day[d] = per_day.get(d, 0) + r["time"] / 1000
        b["reviewSecByDay"] = per_day
        b["studied"] = studied
        b["firstDaySec"] = first_day
        if b["newLeft"] == 0 and not b.get("closed"):
            b["closed"] = True
            b["closedAt"] = time.time()
        if b.get("closed") and b["learning"] == 0:
            b["reviewsFinal"] = True
    save_state()


# ---------- estimates ----------

def estimates(block):
    items = all_items(block)
    counts = cache["cardCounts"].get(block["id"], {})
    tiers = selected_tiers()

    vid_active = {src: 0 for src in PRIOR_VIDEO_FACTOR}
    vid_dur = {src: 0 for src in PRIOR_VIDEO_FACTOR}
    brick_active = brick_n = 0
    amb_active = amb_q = 0
    for it in items:
        st = peek_state(it["id"])
        act = st.get("activeSec", 0)
        if not is_done(block, it) or act <= 0:
            continue
        if it["type"] == "video":
            d = duration(block, it)
            if d and act > 0.2 * d:  # ignore videos marked done without being watched here
                vid_active[it["source"]] += act
                vid_dur[it["source"]] += d
        elif it["type"] == "brick":
            brick_active += act
            brick_n += 1
        elif it["type"] == "amboss" and st.get("questions"):
            amb_active += act
            amb_q += st["questions"]

    batches = [b for b in state["batches"] if b["block"] == block["id"]]
    first_day_logged = sum(b.get("firstDaySec", 0) for b in batches)
    cards_studied = sum(b.get("studied", 0) for b in batches)

    rates = {
        "videoFactor": {
            src: (prior * PRIOR_VIDEO_WEIGHT + vid_active[src]) / (PRIOR_VIDEO_WEIGHT + vid_dur[src])
            for src, prior in PRIOR_VIDEO_FACTOR.items()
        },
        "cardSec": (PRIOR_NEW_CARD_SEC * PRIOR_CARD_WEIGHT + first_day_logged * REVLOG_OVERHEAD)
                   / (PRIOR_CARD_WEIGHT + cards_studied),
        "reviewSec": REVIEW_SEC,
        "revlogOverhead": REVLOG_OVERHEAD,
        "brickSec": (PRIOR_BRICK_SEC * PRIOR_BRICK_WEIGHT + brick_active) / (PRIOR_BRICK_WEIGHT + brick_n),
        "ambossSecPerQ": (PRIOR_AMBOSS_SEC_PER_Q * PRIOR_AMBOSS_WEIGHT + amb_active) / (PRIOR_AMBOSS_WEIGHT + amb_q),
        "learnedFrom": {"videoMin": {k: v / 60 for k, v in vid_dur.items()}, "cards": cards_studied, "bricks": brick_n, "ambossQ": amb_q},
    }
    # Values you typed in Settings replace the learned ones.
    pins = state["settings"].get("pins", {})
    for src in PRIOR_VIDEO_FACTOR:
        if f"{src}Factor" in pins:
            rates["videoFactor"][src] = pins[f"{src}Factor"]
    for key in ("cardSec", "reviewSec", "brickSec", "ambossSecPerQ"):
        if key in pins:
            rates[key] = pins[key]
    rates["pinned"] = sorted(pins)

    per_item = {}
    for it in items:
        done = is_done(block, it)
        st = peek_state(it["id"])
        if it["type"] == "video":
            d = duration(block, it)
            left = 0 if done else max(d - st.get("pos", 0), 0)
            c = counts.get(it["id"], {})
            cards = 0 if done else count_cards(c.get("excl"), tiers)
            per_item[it["id"]] = {
                "video": left * rates["videoFactor"][it["source"]],
                "anki": cards * rates["cardSec"],
                "cards": count_cards(c.get("own"), tiers),
                "newCards": cards,
            }
        elif it["type"] == "brick":
            per_item[it["id"]] = {"other": 0 if done else rates["brickSec"]}
        elif it["type"] == "amboss":
            per_item[it["id"]] = {"other": 0 if done else it.get("questions", 10) * rates["ambossSecPerQ"]}

    open_new = sum(b.get("newLeft", len(b.get("cids", []))) for b in batches if not b.get("closed"))
    work = {"video": 0, "newCards": 0, "reviews": 0, "bricks": 0, "amboss": 0}
    for it in items:
        e = per_item.get(it["id"], {})
        work["video"] += e.get("video", 0)
        work["newCards"] += e.get("anki", 0)
        work["bricks" if it["type"] == "brick" else "amboss"] += e.get("other", 0)
    new_cards_left = open_new + sum(e.get("newCards", 0) for e in per_item.values())
    work["newCards"] += open_new * rates["cardSec"]

    bnb = [it for it in items if it["type"] == "video" and it["source"] == "bnb"]
    bnb_total = sum(duration(block, it) for it in bnb)
    bnb_done = sum(duration(block, it) for it in bnb if is_done(block, it))
    vids = [it for it in items if it["type"] == "video"]

    today = dt.date.fromisoformat(study_day())
    goal = dt.date.fromisoformat(goal_date(block))
    days_left = max((goal - today).days + 1, 1)

    # Reviews before the goal date: ones already scheduled in your deck, plus the
    # ones new cards will generate (spread evenly, a card gets ~1.16 reviews in
    # its first 10 days, so on average it's around for half the time left).
    due = cache.get("reviewsDue", {}).get(block["id"], {})
    existing_reviews = due.get("n", 0)
    due_today = due.get("dueToday", 0)
    waiting_new = due.get("waitingNew", 0)
    new_cards_left += waiting_new
    work["newCards"] += waiting_new * rates["cardSec"]
    fresh_reviews = new_cards_left * FRESH_REVIEWS_PER_CARD_10D * min(1, (days_left / 2) / 10)
    work["reviews"] = (existing_reviews + fresh_reviews) * rates["reviewSec"]
    remaining = sum(work.values())
    # Anki work that belongs to today: reviews actually due now, today's share of
    # reviews new cards will create, the VidAnki deck's new cards (they gate the next
    # video), and an even share of other new cards already unsuspended in your decks.
    today_anki = (due_today + fresh_reviews / days_left) * rates["reviewSec"] \
        + (open_new + waiting_new / days_left) * rates["cardSec"]
    # Everything else can be spread evenly: videos, bricks, AMBOSS and the new
    # cards future videos will unlock. Reviews due on later days belong to those days.
    future_new = work["newCards"] - (open_new + waiting_new) * rates["cardSec"]
    spreadable = work["video"] + work["bricks"] + work["amboss"] + future_new
    today_need = today_anki + spreadable / days_left

    day_totals = day_breakdown(block)
    today_sec = sum(day_totals.get(today.isoformat(), {}).values())
    past = [sum(day_totals.get((today - dt.timedelta(days=i)).isoformat(), {}).values()) for i in (1, 2, 3)]
    active_past = [p for p in past if p > 0]
    pace = sum(active_past) / len(active_past) if active_past else None
    projected = None
    if pace:
        projected = (today + dt.timedelta(days=max((remaining - min(today_sec, remaining)) / pace, 0))).isoformat()

    return {
        "rates": rates,
        "perItem": per_item,
        "remainingSec": remaining,
        "work": work,
        "cards": {"newLeft": new_cards_left, "existingReviews": existing_reviews,
                  "freshReviews": fresh_reviews, "tiers": tiers,
                  "dueToday": due_today, "waitingNew": waiting_new},
        "todayAnkiSec": today_anki,
        "ankiNow": anki_now(rates),
        "openBatchNew": open_new,
        "bnb": {"doneSec": bnb_done, "totalSec": bnb_total,
                "done": sum(1 for it in bnb if is_done(block, it)), "count": len(bnb)},
        "items": {"done": sum(1 for it in items if is_done(block, it)), "count": len(items),
                  "videosDone": sum(1 for it in vids if is_done(block, it)), "videos": len(vids)},
        "daysLeft": days_left,
        "perDaySec": remaining / days_left,
        "todaySec": today_sec,
        "todayNeededSec": today_need + today_sec,
        "paceSec": pace,
        "projectedFinish": projected,
        "today": today.isoformat(),
        "days": day_totals,
        "cardCountsSource": cache.get("cardCountsSource"),
    }


def anki_now(rates):
    d = cache.get("deckNow", {})
    sec = d.get("due", 0) * rates["reviewSec"] + d.get("new", 0) * rates["cardSec"]
    return {"due": d.get("due", 0), "new": d.get("new", 0), "sec": sec, "minSec": ANKI_ROW_MIN_SEC}


def day_breakdown(block):
    """Study seconds per day by kind. Anki time is everything you did in Anki
    that day (new + reviews), scaled up from Anki's log to your real time."""
    days = {d: dict(v) for d, v in state["days"].items()}
    batch_anki = {}
    for b in state["batches"]:
        if b["block"] != block["id"]:
            continue
        for d, sec in b.get("reviewSecByDay", {}).items():
            batch_anki[d] = batch_anki.get(d, 0) + sec
    for d in set(batch_anki) | set(cache["ankiByDay"]):
        logged = cache["ankiByDay"].get(d, batch_anki.get(d, 0))
        days.setdefault(d, {})["anki"] = logged * REVLOG_OVERHEAD
    return days


def refresh_anki_today():
    """Logged Anki time today across all cards (reviews of your whole deck count too)."""
    day = study_day()
    start_ms = (dt.datetime.fromisoformat(day) + dt.timedelta(hours=DAY_ROLLOVER_HOUR)).timestamp() * 1000
    cids = anki("findCards", query="rated:1")
    total = 0
    if cids:
        for revs in anki("getReviewsOfCards", cards=[str(c) for c in cids]).values():
            total += sum(r["time"] for r in revs if r["id"] >= start_ms) / 1000
    cache["ankiByDay"][day] = total


# ---------- API ----------

def current_gate(block):
    open_b = [b for b in state["batches"]
              if b["block"] == block["id"] and not b.get("closed") and not b.get("skipped")]
    if not open_b:
        return None
    b = open_b[-1]
    item = find_item(block, b["itemId"])
    return {
        "itemId": b["itemId"], "title": item["title"],
        "needsAnki": b.get("needsAnki", False),
        "total": len(b.get("cids", [])), "newLeft": b.get("newLeft", len(b.get("cids", []))),
        "learning": b.get("learning", 0), "unsuspended": b.get("unsuspended", 0),
        "deckError": b.get("deckError"), "openBatches": len(open_b),
    }


anki_status = {"ok": False, "error": None}


def anki_worker():
    """Talk to Anki in the background so page loads never wait on it."""
    slow_at = 0
    was_ok = True
    while True:
        try:
            ok = anki_reachable()
            error = None
            if ok:
                try:
                    for block in BLOCKS.values():
                        with lock:
                            process_pending_batches(block)
                    refresh_batches()
                    refresh_deck_now()
                    for block in BLOCKS.values():
                        if block["id"] not in cache["cardCounts"]:
                            refresh_card_counts_from_anki(block)
                    if not was_ok and state.get("deckFallback"):  # Anki restarted: rebuild in proper order
                        state["deckBuiltDay"] = None
                    if state.get("deckBuiltDay") != study_day():  # new day: pull in today's reviews
                        with lock:
                            rebuild_filtered_deck()
                            save_state()
                    missing_due = any(b not in cache.get("reviewsDue", {}) for b in BLOCKS)
                    if missing_due or time.time() - slow_at > 60:
                        slow_at = time.time()
                        for block in BLOCKS.values():
                            refresh_reviews_due(block)
                        refresh_anki_today()
                        save_cache()
                except AnkiError as e:
                    error = str(e)
            anki_status.update(ok=_anki_ok["ok"], error=error)
            was_ok = _anki_ok["ok"]
        except Exception as e:  # keep the worker alive no matter what
            anki_status.update(error=f"{e.__class__.__name__}: {e}")
        time.sleep(6)


def api_state(block_id):
    block = BLOCKS[block_id]
    ok = anki_status["ok"]
    anki_error = anki_status["error"]
    if block["id"] not in cache["cardCounts"] and not ok:
        try:
            refresh_card_counts_from_sqlite(block)
        except Exception as e:  # never block the UI on counts
            anki_error = anki_error or f"Card counts unavailable: {e}"

    est = estimates(block)
    clusters = []
    for c in block["clusters"]:
        out = []
        for it in c["items"]:
            st = peek_state(it["id"])
            e = {
                "id": it["id"], "type": it["type"], "title": it["title"], "source": it.get("source"),
                "done": is_done(block, it), "note": it.get("note"), "questions": it.get("questions"), "url": it.get("url"),
                "pos": st.get("pos", 0), "activeSec": st.get("activeSec", 0),
                "ambossLog": st.get("amboss"), "est": est["perItem"].get(it["id"], {}),
            }
            if it["type"] == "video":
                path, _ = resolve_video(block, it)
                e["missing"] = path is None
                e["duration"] = duration(block, it)
                e["file"] = it["file"]
            out.append(e)
        clusters.append({"title": c["title"], "items": out})
    return {
        "block": {"id": block["id"], "name": block["name"], "goalDate": goal_date(block)},
        "blocks": [{"id": b["id"], "name": b["name"]} for b in BLOCKS.values()],
        "clusters": clusters,
        "stats": est,
        "anki": {"ok": ok, "error": anki_error, "gate": current_gate(block), "deck": FILTERED_DECK},
        "settings": state["settings"],
        "current": state.get("current", {}).get(block_id),
    }


def api_heartbeat(body):
    block = BLOCKS[body["block"]]
    item = find_item(block, body["id"])
    delta = max(0.0, min(float(body.get("delta", 0)), 120.0))
    st = item_state(item["id"])
    st["activeSec"] = st.get("activeSec", 0) + delta
    if "pos" in body:
        st["pos"] = float(body["pos"])
    kind = item.get("source") or item["type"]
    add_day_time(kind, delta)
    state.setdefault("current", {})[block["id"]] = item["id"]
    save_state()
    return {"ok": True}


def api_set_time(body):
    """Set an item's tracked time (timer reset or manual edit); today's total moves by the difference."""
    block = BLOCKS[body["block"]]
    item = find_item(block, body["id"])
    sec = max(0.0, float(body["sec"]))
    st = item_state(item["id"])
    delta = sec - st.get("activeSec", 0)
    st["activeSec"] = sec
    day = state["days"].setdefault(study_day(), {})
    kind = item.get("source") or item["type"]
    day[kind] = max(0.0, day.get(kind, 0) + delta)
    save_state()
    return {"ok": True, "activeSec": sec}


def api_done(body):
    block = BLOCKS[body["block"]]
    item = find_item(block, body["id"])
    st = item_state(item["id"])
    result = {"renamed": None, "batch": None}
    if item["type"] == "video":
        path, done = resolve_video(block, item)
        if path is None:
            raise FileNotFoundError(f'Video file not found: {item["file"]}')
        if not done:
            _, under = video_paths(block, item)
            os.rename(path, under)
            result["renamed"] = under.name
    if item["type"] == "amboss" and body.get("amboss"):
        st["amboss"] = body["amboss"]
        st["questions"] = int(body["amboss"].get("n") or 0)
    st["done"] = True
    st["doneAt"] = time.time()
    if item.get("tags") and not body.get("skipAnki"):
        batch = {"block": block["id"], "itemId": item["id"], "createdAt": time.time(), "needsAnki": True}
        state["batches"].append(batch)
        if anki_reachable():
            try:
                process_batch(block, batch)
                refresh_card_counts_from_anki(block)
            except AnkiError as e:
                batch["error"] = str(e)
        result["batch"] = {k: batch.get(k) for k in ("needsAnki", "unsuspended", "deckError")}
        result["batch"]["newCards"] = len(batch.get("cids", []))
    save_state()
    return result


def api_undone(body):
    block = BLOCKS[body["block"]]
    item = find_item(block, body["id"])
    if item["type"] == "video":
        path, done = resolve_video(block, item)
        if path is not None and done:
            plain, _ = video_paths(block, item)
            os.rename(path, plain)
    item_state(item["id"])["done"] = False
    save_state()
    return {"ok": True}


def api_skip_gate(body):
    for b in state["batches"]:
        if b["block"] == body["block"] and not b.get("closed"):
            b["skipped"] = True
    save_state()
    return {"ok": True}


def api_rebuild_deck(_body):
    cards = rebuild_filtered_deck()
    save_state()
    refresh_deck_now()
    return {"cards": cards}


def api_open_anki(_body):
    try:
        anki("guiDeckOverview", name=FILTERED_DECK)
    except AnkiError:
        pass
    # Bring the Anki window to the front (macOS).
    subprocess.Popen(["open", "-a", "Anki"])
    return {"ok": True}


def api_settings(body):
    for k in ("rate", "dark"):
        if k in body:
            state["settings"][k] = body[k]
    if "goalDate" in body:
        block_id, date = body["goalDate"]["block"], body["goalDate"]["date"]
        dt.date.fromisoformat(date)  # validate
        state["settings"].setdefault("goalDates", {})[block_id] = date
        cache.get("reviewsDue", {}).pop(block_id, None)  # recount reviews through the new date
    if "pins" in body:
        pins = state["settings"].setdefault("pins", {})
        for k, v in body["pins"].items():
            if v is None or v == "":
                pins.pop(k, None)
            else:
                pins[k] = float(v)
    if "tiers" in body:
        state["settings"]["tiers"] = [t for t in TIERS if t in body["tiers"]] or ["1"]
    if "reviewsInDeck" in body:
        state["settings"]["reviewsInDeck"] = bool(body["reviewsInDeck"])
        state["deckBuiltDay"] = None  # the worker rebuilds the deck within a few seconds
    save_state()
    return state["settings"]


def api_refresh_counts(body):
    block = BLOCKS[body["block"]]
    if anki_reachable():
        refresh_card_counts_from_anki(block)
    else:
        refresh_card_counts_from_sqlite(block)
    return {"ok": True, "source": cache.get("cardCountsSource")}


POST_ROUTES = {
    "/api/heartbeat": api_heartbeat,
    "/api/set-time": api_set_time,
    "/api/done": api_done,
    "/api/undone": api_undone,
    "/api/skip-gate": api_skip_gate,
    "/api/open-anki": api_open_anki,
    "/api/rebuild-deck": api_rebuild_deck,
    "/api/settings": api_settings,
    "/api/refresh-counts": api_refresh_counts,
}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(STATIC_DIR), **kw)

    def log_message(self, fmt, *args):
        if args and "/api/heartbeat" in str(args[0]):
            return
        super().log_message(fmt, *args)

    def end_headers(self):
        # page files change while you use VidAnki; make the browser check for updates
        if not self.path.startswith("/media/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_json(self, obj, status=200):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if url.path == "/api/state":
            qs = urllib.parse.parse_qs(url.query)
            block_id = qs.get("block", [state.get("activeBlock") or next(iter(BLOCKS))])[0]
            with lock:
                try:
                    return self.send_json(api_state(block_id))
                except Exception as e:
                    return self.send_json({"error": f"{e.__class__.__name__}: {e}"}, 500)
        if url.path.startswith("/media/"):
            return self.serve_media(url.path)
        return super().do_GET()

    def do_POST(self):
        fn = POST_ROUTES.get(urllib.parse.urlparse(self.path).path)
        if fn is None:
            return self.send_json({"error": "not found"}, 404)
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        with lock:
            try:
                return self.send_json(fn(body))
            except Exception as e:
                return self.send_json({"error": f"{e.__class__.__name__}: {e}"}, 500)

    def serve_media(self, path):
        try:
            _, _, block_id, item_id = path.split("/", 3)
            block = BLOCKS[block_id]
            item = find_item(block, urllib.parse.unquote(item_id))
            file, _ = resolve_video(block, item)
        except (ValueError, KeyError):
            file = None
        if file is None:
            return self.send_error(HTTPStatus.NOT_FOUND)
        size = file.stat().st_size
        ctype = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
        start, end = 0, size - 1
        rng = self.headers.get("Range")
        m = re.match(r"bytes=(\d*)-(\d*)", rng or "")
        if m:
            if m.group(1):
                start = int(m.group(1))
                if m.group(2):
                    end = min(int(m.group(2)), size - 1)
            elif m.group(2):  # suffix range: last N bytes
                start = max(size - int(m.group(2)), 0)
            if start >= size:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            self.send_response(HTTPStatus.PARTIAL_CONTENT)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(HTTPStatus.OK)
        length = end - start + 1
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        self.end_headers()
        try:
            with open(file, "rb") as f:
                f.seek(start)
                while length > 0:
                    chunk = f.read(min(1 << 20, length))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    length -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass  # browser cancelled the range request (normal when seeking)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8770)
    ap.add_argument("--lan", action="store_true", help="listen on all interfaces (phone access)")
    args = ap.parse_args()
    host = "0.0.0.0" if args.lan else "127.0.0.1"
    srv = ThreadingHTTPServer((host, args.port), Handler)
    threading.Thread(target=anki_worker, daemon=True).start()
    print(f"VidAnki on http://localhost:{args.port}  (blocks: {', '.join(BLOCKS)})")
    srv.serve_forever()


if __name__ == "__main__":
    main()
