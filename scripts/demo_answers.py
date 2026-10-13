"""Send a few customer questions to the running backend and print what the agent would see.

Start the backend first (from backend/):
    LLM_API_KEY="$DEEPSEEK_API_KEY" ../.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8001
Then, in another terminal:
    ../.venv/bin/python ../scripts/demo_answers.py
"""
import httpx

QUESTIONS = [
    "How much is the team plan per person?",            # direct doc answer
    "We added three people halfway through the year, how is that billed?",  # docs + LLM
    "Can I pay with PayPal?",                            # not in the docs
    "Are you HIPAA compliant?",                          # not in the docs
    "Do you integrate with Salesforce?",                 # not in the docs
    "honestly we're thinking of cancelling, it's too expensive",  # upset customer
]

with httpx.Client(timeout=60, trust_env=False) as client:
    for q in QUESTIONS:
        r = client.post("http://127.0.0.1:8001/api/chat", json={"question": q})
        r.raise_for_status()
        d = r.json()
        score = d.get("score")
        print(f"\nQ: {q}\n[{d.get('source')}  score={score if score is None else round(score, 3)}  file={d.get('file')}]")
        print(d.get("answer", "").strip())
