# Laya evaluation for taskforce

Tested locally on 2026-09-24. No production extension code changed.

## Conclusion

Laya is fast enough for local classification, but these released checkpoints are not reliable enough to decide whether taskforce should keep working or yield to the user. The best exploratory framing still missed explicit pauses on fresh examples. Do not use it to authorize execution or override a conversational pause.

An optional experiment that only suppresses reminders remains plausible. It would need real session examples, owner-reviewed labels, and separate training, calibration, and evaluation data. Removing unwanted reminders does not require a model.

## Version verification

Queried PyPI and the Hugging Face model API directly, rather than relying on search snippets:

- Latest published PyPI runtime: `laya==0.3.20`.
- Model repository: `convaiinnovations/laya`.
- Resolved `main`: `55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851`.
- Repository last modified: `2026-09-24T05:39:22Z`.
- Tested root English, `multilingual`, and `typed-decisions` from that pinned revision.
- The current model card says runtime 0.3.20 leaves the checkpoints unchanged. A new runtime version is not a new trained model.

Weights came directly from the official repository. This experiment used the Python reference runtime, not a potentially older third-party ONNX export. `requirements-frozen.txt` records installed dependencies. `provenance.json` records the release metadata queried before testing.

Sources:

- https://pypi.org/pypi/laya/json
- https://huggingface.co/api/models/convaiinnovations/laya
- https://huggingface.co/convaiinnovations/laya/tree/55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851
- https://huggingface.co/convaiinnovations/laya/blob/55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851/README.md

## Method

This is a small, synthetic engineering probe, not a representative benchmark or a production acceptance test. The assistant authored both cases and expected labels. No real user transcripts, fine-tuning, domain calibration, or generative-model comparator were used.

`cases.json` contains 32 balanced English cases, 16 pause and 16 execute, plus four German/Hindi smoke cases. Cases cover waiting for input, discussion, scope completion, explicit continuation, negation, quoted instructions, changed user intent, and instruction-like tool output. Model inputs omit case IDs and expected labels.

The initial test supplies the recent conversation as JSON alongside an unfinished task list. It asks four questions per call:

1. A two-option choice with neutral keys.
2. The same options in reverse insertion order.
3. The meanings assigned to the keys swapped.
4. A boolean `noul` equivalent.

Decisions use a 0.5 threshold on pause probability, without tuning. Raw responses are retained, including both `confidence` and `answer_confidence`. Those fields are not interchangeable: the runtime's choice `confidence` is entropy-based, while `answer_confidence` reports the selected answer probability. Metrics use the actual option probabilities.

A keyword/question-mark baseline was fixed before seeing model results. It is deliberately crude and English-only, not a recommended controller. It scores 27/32 on the initial English cases and 10/16 on the fresh cases. Always pausing or always executing scores 50% on each balanced set.

After inspecting initial failures, `followup.py` tries shorter instructions, removal of task context, plain transcript formatting, and a narrower waiting-for-input question. These are post-hoc diagnostics, so improvements on the same cases are optimistic.

Finally, `holdout.json` adds 16 fresh English cases, eight pause and eight execute. `holdout.py` tests the selected short transcript framing without further adjustment. The same author created these fresh cases after seeing earlier failures; this is not a blinded independent holdout.

## Results

Initial English cases, standard choice question:

| Checkpoint | Correct | Executed when it should pause | Paused when it should execute |
| --- | ---: | ---: | ---: |
| English | 22/32 | 10/16 | 0/16 |
| Multilingual | 20/32 | 5/16 | 7/16 |
| Typed-decisions | 17/32 | 14/16 | 1/16 |

Short question with plain transcript, selected during follow-up:

| Checkpoint | Original English cases | Fresh English cases | False execution on fresh pause cases |
| --- | ---: | ---: | ---: |
| English | 25/32 | 11/16 | 5/8 |
| Multilingual | 28/32 | 12/16 | 3/8 |
| Typed-decisions | 23/32 | 11/16 | 5/8 |

The multilingual checkpoint benefits from simpler input formatting. Its fresh-case result is still inadequate for execution control. The typed-decisions checkpoint's specialization in other workflows did not make it the best taskforce classifier.

Concrete failures:

- On fresh case `h02`, every checkpoint chooses execution despite the assistant explicitly saying it needs the user's decision before proceeding.
- On `h03`, every checkpoint chooses execution after the user says to leave the work until tomorrow.
- The English model assigns 92.58% execution probability to the original permission-to-change-database case with the short transcript framing.
- Reversing option order changes 8/36 initial decisions for both English and multilingual, and 2/36 for typed-decisions. The case text is unchanged.
- The initial multilingual boolean question scores 15/32 and produces ten incorrect answers at probability >= 90%. Structured output is not reliable judgment.
- `action.act_probability` is 1.0 throughout the initial case responses. It cannot distinguish correct from incorrect decisions here.

The four language cases are too few to support language-wide conclusions. In the initial framing, even multilingual misses the Hindi pause. See raw responses rather than extrapolating from four examples.

### Task context and truncation

A separate stress probe surrounds an explicit stop with about 1,300–1,500 tokens of historical task text. Multilingual with its default 1,024-token budget recognizes the stop at the beginning, but predicts execution at 93.02% when the stop is at the end. With `max_len=8192`, the end-position prediction switches to pause at 56.22%.

The runtime's default state packing retains the beginning of a string/JSON state and truncates its tail. This demonstrates an input-loss failure, not evidence that the model read and rejected the stop. Do not pass an ever-growing task list followed by the latest user message. Increasing the budget fixes this particular truncation case, not the short-context classification failures.

## Local performance

Hardware: a laptop with an 8 GB NVIDIA GPU and an 8-core Intel CPU. Python 3.12.13, PyTorch 2.14.0, Transformers 5.17.0. CPU measurements use four PyTorch threads. TileLang fast path disabled. All timings are warm process measurements with GPU synchronization, not cold application startup or download time.

| Checkpoint | GPU median, one question | GPU median, four questions | CPU median, one short question | Peak allocated CUDA memory during initial cases |
| --- | ---: | ---: | ---: | ---: |
| English | 49 ms | 53 ms | 459 ms | 2,356 MiB |
| Multilingual | 40 ms | 42 ms | 159 ms | 1,518 MiB |
| Typed-decisions | 49 ms | 54 ms | 474 ms | 2,356 MiB |

GPU one-question timing uses the original longer schema; CPU uses the short follow-up schema. These are approximate deployment costs, not a controlled GPU-versus-CPU benchmark. Twelve requests provide each one-question median; 36 requests provide each four-question median. Three warmup calls precede the initial GPU cases and CPU timings. CUDA memory excludes allocations outside PyTorch and is not total process RAM. Cached-weight loading ranged from about 1 to 10 seconds and was affected by filesystem/import warmup.

## Reproduce

Use a separate environment. The extension does not acquire a Python or model dependency.

```bash
uv venv --python 3.12 /tmp/taskforce-laya-eval/.venv
uv pip install --python /tmp/taskforce-laya-eval/.venv/bin/python \
  -r experiments/laya/requirements-frozen.txt

USE_TF=0 /tmp/taskforce-laya-eval/.venv/bin/python experiments/laya/evaluate.py
USE_TF=0 /tmp/taskforce-laya-eval/.venv/bin/python experiments/laya/followup.py
USE_TF=0 /tmp/taskforce-laya-eval/.venv/bin/python experiments/laya/holdout.py
```

The initial evaluator accepts `--device cpu`; the follow-up and fresh-case scripts require CUDA for their GPU runs. The latter scripts reuse the pinned snapshot downloaded by the initial evaluator. Downloads occupy several GB in the normal Hugging Face cache. Dependencies also require several GB. No model weights are committed.

Files:

- `results.json`: initial cases, latency samples, long-context probes, and metrics.
- `followup-results.json`: post-hoc framing diagnostics and CPU timing samples.
- `holdout-results.json`: fresh-case results with the selected framing.
- `cases.json`, `holdout.json`: exact inputs and expected labels.
- `evaluate.py`, `followup.py`, `holdout.py`: runnable experiments.

## Recommendation

Do not integrate these weights as a conversation controller. If further work is justified, start with narrowly scoped, observation-only classification on owner-reviewed real sessions. Evaluate reminder suppression separately from continuation authorization. Keep explicit user controls deterministic and keep the extension usable without a model.
