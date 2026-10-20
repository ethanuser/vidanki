"""VidAnki bridge: adds actions AnkiConnect lacks (filtered decks).

Patches extra methods onto AnkiConnect's class, so they are reachable through
AnkiConnect's normal HTTP endpoint and run on Anki's main thread like every
other AnkiConnect action.
"""
import sys

from aqt import gui_hooks, mw

ANKICONNECT_ID = "2055492159"


def _api(func):
    func.api = True
    func.versions = ()
    return func


@_api
def vidankiFilteredDeck(self, name, search, limit=9999):
    """Create (or update) a filtered deck `name` from `search` and rebuild it.

    Cards come in due order, so new cards keep the deck's intended order.
    Returns the number of cards pulled into the deck.
    """
    from anki.decks import DeckId, FilteredDeckConfig

    col = self.collection()
    existing = col.decks.by_name(name)
    did = DeckId(existing["id"]) if existing and existing.get("dyn") else DeckId(0)
    deck = col.sched.get_or_create_filtered_deck(deck_id=did)
    deck.name = name
    cfg = deck.config
    cfg.reschedule = True
    del cfg.search_terms[:]
    cfg.search_terms.append(
        FilteredDeckConfig.SearchTerm(
            search=search,
            limit=limit,
            order=FilteredDeckConfig.SearchTerm.Order.DUE,
        )
    )
    col.sched.add_or_update_filtered_deck(deck)
    mw.reset()
    new = col.decks.by_name(name)
    return {"deckId": new["id"], "cards": len(col.find_cards(f'"deck:{name}"'))}


@_api
def vidankiEmptyFilteredDeck(self, name):
    col = self.collection()
    deck = col.decks.by_name(name)
    if deck and deck.get("dyn"):
        col.sched.empty_filtered_deck(deck["id"])
        mw.reset()
    return True


def _patch():
    mod = sys.modules.get(ANKICONNECT_ID)
    cls = getattr(mod, "AnkiConnect", None)
    if cls is None:
        print("vidanki_bridge: AnkiConnect not found; filtered decks unavailable")
        return
    cls.vidankiFilteredDeck = vidankiFilteredDeck
    cls.vidankiEmptyFilteredDeck = vidankiEmptyFilteredDeck


# Add-ons load in folder-name order, so AnkiConnect is normally imported
# already; the profile hook covers any other load order.
_patch()
gui_hooks.profile_did_open.append(_patch)
