"""Retrieval check for the demo knowledge base. No LLM calls, no API key needed.

Each case is a question phrased the way a customer would say it on a call,
with the FAQ entry id it should match (or None when the docs don't cover it).
The report shows top-1 accuracy and the score ranges, which is what you need
to set SIMILARITY_HIT_THRESHOLD / SIMILARITY_PARTIAL_THRESHOLD.

Run from backend/ after building the index:
    cd backend
    python ../scripts/rebuild_index_offline.py
    python ../scripts/eval_retrieval.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app.config import settings  # noqa: E402
from app.rag.embedder import embed_query  # noqa: E402
from app.rag.index import is_loaded, load_index, search  # noqa: E402

CASES: list[tuple[str, str | None]] = [
    ("What are the different plans you offer?", "P01"),
    ("How much is the team plan per person?", "P02"),
    ("What does business cost if we pay monthly?", "P03"),
    ("What do I get on Business that I don't get on Team?", "P04"),
    ("Is there a free version?", "P05"),
    ("Is it cheaper if we pay for the whole year?", "P06"),
    ("We're a nonprofit, do you have any discount?", "P07"),
    ("We added three people halfway through the year, how is that billed?", "P09"),
    ("If I remove someone do I get money back?", "P10"),
    ("Do I have to pay for guest users?", "P11"),
    ("Can I get a refund on my annual plan?", "B01"),
    ("I see two charges on my card this month", "B02"),
    ("Why did my bill go up?", "B03"),
    ("Can we pay by bank transfer?", "B04"),
    ("Where do I download my invoices?", "B05"),
    ("My card got declined, will we lose access?", "B07"),
    ("Do you support single sign-on with Okta?", "S01"),
    ("Can we turn on two-factor for everyone?", "S03"),
    ("Do you have a SOC 2 report?", "S04"),
    ("Where is our data hosted?", "S06"),
    ("How do I export all our tasks?", "S08"),
    ("What happens to our data after we cancel?", "S10"),
    ("Can we run this on our own servers?", "S11"),
    ("Is there an API and what's the rate limit?", "I02"),
    ("How do I hook it up to Slack?", "I04"),
    ("Can I bring over my boards from Trello?", "I05"),
    ("I can't log in, it keeps sending me back to the login page", "T01"),
    ("My coworker never got the invite email", "T02"),
    ("Slack notifications stopped coming through", "T03"),
    ("My spreadsheet import keeps failing", "T05"),
    ("How do I cancel?", "C01"),
    ("Is there a free trial and do I need a card?", "C04"),
    ("What hours is support open?", "C05"),
    # Not covered by the docs: these should stay below the partial threshold
    ("Are you HIPAA compliant?", None),
    ("Do you integrate with Salesforce?", None),
    ("Can I pay with PayPal?", None),
    ("What's the weather like today?", None),
]


def main() -> None:
    load_index(settings.index_path)
    if not is_loaded():
        sys.exit("Index not found. Run ../scripts/rebuild_index_offline.py first.")
    hits, top3, rows = 0, 0, []
    in_scope = [c for c in CASES if c[1]]
    for question, expected in CASES:
        results = search(embed_query(question), top_k=3)
        top = results[0]
        got = top.get("id", "").split("-")[0]
        ok = expected is not None and got == expected
        in_top3 = expected is not None and expected in [r.get("id", "").split("-")[0] for r in results]
        hits += ok
        top3 += in_top3
        rows.append((top["score"], expected, got, ok, question))

    print(f"Top-1 accuracy (in-scope): {hits}/{len(in_scope)}")
    print(f"Top-3 recall (in-scope):   {top3}/{len(in_scope)}  (partial matches send the top 3 to the LLM)")
    wrong = [r[0] for r in rows if r[1] and not r[3]] + [r[0] for r in rows if r[1] is None]
    above = [r for r in rows if r[0] >= settings.similarity_hit_threshold]
    print(f"Direct answers (score >= hit): {len(above)}, wrong among them: {sum(1 for r in above if not r[3])}")
    if wrong:
        print(f"Highest score of a wrong or out-of-scope top-1: {max(wrong):.3f}")
    print(f"Thresholds: hit={settings.similarity_hit_threshold} partial={settings.similarity_partial_threshold}\n")
    for score, expected, got, ok, question in sorted(rows, reverse=True):
        mark = "OK " if ok else ("-- " if expected is None else "MISS")
        print(f"{score:.3f}  {mark}  expected={expected or 'none':4}  got={got:4}  {question}")
    in_scores = [r[0] for r in rows if r[1] and r[3]]
    out_scores = [r[0] for r in rows if r[1] is None]
    if in_scores and out_scores:
        print(f"\nCorrect matches score {min(in_scores):.3f}-{max(in_scores):.3f}; "
              f"out-of-scope questions score {min(out_scores):.3f}-{max(out_scores):.3f}.")
        print("Set the partial threshold above the out-of-scope max and the hit threshold "
              "where wrong matches stop appearing.")


if __name__ == "__main__":
    main()
