# Live Call Assistant

A desktop assistant for customer support and sales calls. It listens to the call audio on your Mac, transcribes what the customer asks, finds the answer in your product docs, and shows the agent a short reply they can say out loud. When the docs don't cover the question, it says so instead of making something up.

The demo ships with docs for **Pebblework**, a fictional project management product (plans, billing, security, integrations, troubleshooting). Swap in your own Markdown docs to use it with a real product.

> Platform: Apple Silicon Macs (unsigned local build). The user guide is [README-mac.md](README-mac.md).

## What it does

- **Live transcript on the Mac.** Call audio is captured from the system audio you choose to share and transcribed locally with faster-whisper. With the default local engine, raw audio never leaves the machine.
- **Docs first, model second.** Every question is matched against the product docs with a local embedding model (bge-small-en-v1.5) and a FAISS index:
  - close match → the doc answer is shown directly, with no LLM call and no token cost;
  - partial match → DeepSeek writes a short answer using only the top doc sections;
  - no match → the answer says the docs don't cover it, so the agent doesn't promise anything that isn't true.
- **The agent stays in control.** The transcript goes into an editable box. Nothing is sent until the agent clicks Send.
- **Built for real calls.** Follow-up questions use the last two rounds as context, common questions are answered from a local cache, and answers are short enough to read while talking.
- **Key handling.** The DeepSeek key is entered in the app and kept in the macOS keychain. It is never written to project files.

## How it works

```
call audio (system audio you share)
   → noise reduction + voice activity detection
   → local faster-whisper transcript → editable input box
   → [agent clicks Send]
   → local embedding search over product docs (FAISS)
        ├─ score ≥ hit threshold   → doc answer, no LLM
        ├─ score ≥ partial         → DeepSeek + top doc sections
        └─ below partial           → DeepSeek told nothing matched → "not in the docs"
   → streamed answer + source file + match score
```

| Part | Tech |
|---|---|
| Desktop shell | Electron (always-on-top window, keychain via safeStorage) |
| UI | React + TypeScript + Vite |
| Backend | Python, FastAPI, Server-Sent Events, WebSocket for streaming audio |
| Speech | faster-whisper (local), optional cloud streaming recognition |
| Retrieval | bge-small-en-v1.5 embeddings, FAISS |
| Answers | DeepSeek (OpenAI-compatible API) |

## Retrieval results

`scripts/eval_retrieval.py` asks 37 questions phrased the way customers actually talk ("I see two charges on my card this month", "Can we run this on our own servers?"). 33 are covered by the docs, 4 are not (PayPal, Salesforce, HIPAA, small talk).

| Metric | Result |
|---|---|
| Top-1 accuracy (covered questions) | 33 / 33 |
| Top-3 recall (what the LLM gets on partial matches) | 33 / 33 |
| Answers shown straight from the docs (score ≥ 0.80) | 9, all correct, 0 tokens used |
| Highest score of any wrong or out-of-scope match | 0.703 |

The direct-answer threshold sits at 0.80, with a 0.10 margin above the highest wrong match. Everything between 0.60 and 0.80 goes to the LLM together with the top three doc sections, so "Can I pay with PayPal?" gets the payment-methods section and the answer says PayPal isn't listed, instead of guessing.

## What gets sent to DeepSeek

Only when the agent clicks Send and the docs don't fully answer the question: the current question, the last two Q&A rounds, up to three matching doc sections and the system prompt. Raw audio and the full knowledge base are never sent.

## Run it

Building the Mac app:

```bash
python scripts/download-models.py      # embedding + speech models (one time)
cd backend && python ../scripts/rebuild_index_offline.py && cd ..
npm run dist:mac
bash scripts/verify-mac-bundle.sh
```

Checks that don't need an API key:

```bash
npm test
npm test --prefix frontend
.venv/bin/python -m pytest backend/tests -q
cd backend && python ../scripts/eval_retrieval.py   # retrieval accuracy on 37 customer-style questions (see results above)
```

## Use your own docs

Put Markdown files in `data/knowledge/`, one entry per question:

```markdown
## B01：Do you offer refunds?

> On annual plans, you can get a full refund within 30 days ...

**Follow-up: How long does a refund take?**
> Refunds go back to the original card in 5 to 10 business days.
```

Then rebuild the index and rerun `scripts/eval_retrieval.py` with a few questions phrased the way your customers talk, to set the match thresholds.

---

## 中文說明

客服／業務通話即時助理（Mac 桌面版）。在本機把通話語音轉成文字，先從產品文件找答案，找得到就直接顯示、不花 token；找不到時才呼叫 DeepSeek，而且文件沒寫的內容會明確說「文件沒有」，不會亂編。示範用的產品 Pebblework 是虛構的。
