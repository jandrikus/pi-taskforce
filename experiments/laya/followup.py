"""Post-hoc diagnostics, not an independent holdout evaluation."""
import gc
import json
import statistics
import time
from pathlib import Path
from evaluate import HERE, REVISION, QUESTIONS, state_for, predict, metrics, torch, laya
from huggingface_hub import snapshot_download

torch.set_num_threads(4)
cases = json.loads((HERE / "cases.json").read_text())
patterns = [prefix + name for prefix in ("", "multilingual/", "typed-decisions/")
            for name in ("rl_agent_config.json", "model.safetensors", "tokenizer/*", "encoder/*")]
snapshot = snapshot_download("convaiinnovations/laya", revision=REVISION, allow_patterns=patterns, local_files_only=True)
short = {"normal": {"type": "choice", "instructions": "What should the coding assistant do next?", "criteria": {"A": "Wait for the user or discuss without executing more tasks.", "B": "Continue implementing or investigating the requested work."}}}
waiting = {"normal": {"type": "choice", "instructions": "Is the assistant waiting for input from the user?", "criteria": {"A": "The assistant is waiting for the user to answer or decide.", "B": "The assistant is not waiting for user input."}}}
# Obvious direct waiting examples, frozen before this diagnostic run.
waiting_ids = {"pause-explicit", "pause-choice", "pause-permission", "pause-implicit-choice", "pause-missing-secret", "pause-reconsider", "pause-negated-continue", "pause-latest-wins", "pause-tool-injection", "de-pause", "hi-pause"}
not_waiting_ids = {c["id"] for c in cases if c["expected"] == "execute"}
report = {"revision": REVISION, "post_hoc": True, "schemas": {"short": short, "waiting": waiting}, "models": {}}
for name, subfolder in (("english", None), ("multilingual", "multilingual"), ("typed-decisions", "typed-decisions")):
    agent = laya.load(snapshot, subfolder=subfolder, device="cuda")
    model = {}
    for variant in ("short_with_tasks", "short_without_tasks", "short_transcript", "waiting_only"):
        rows = []
        for case in cases:
            if variant == "waiting_only" and case["id"] not in waiting_ids | not_waiting_ids:
                continue
            state = state_for(case)
            schema = short
            expected = case["expected"]
            if variant == "short_without_tasks":
                del state["unfinished_tasks"]
            elif variant == "short_transcript":
                state = "\n".join(f"{k}: {case[k]}" for k in ("history", "user", "tool_output", "assistant") if k in case)
            elif variant == "waiting_only":
                schema = waiting
                state = case["assistant"]
                expected = "pause" if case["id"] in waiting_ids else "execute"
            result, ms = predict(agent, state, schema)
            rows.append({"id": case["id"], "language": case.get("language", "en"), "expected": expected, "latency_ms": ms, "result": result})
        model[variant] = {"rows": rows, "english": metrics([r for r in rows if r["language"] == "en"], "normal"), "all": metrics(rows, "normal")}
    # CPU smoke timing. Same model and precision policy; four threads, warm process.
    del agent
    gc.collect()
    torch.cuda.empty_cache()
    start = time.perf_counter()
    agent = laya.load(snapshot, subfolder=subfolder, device="cpu")
    model["cpu_load_seconds"] = time.perf_counter() - start
    for _ in range(3):
        predict(agent, state_for(cases[0]), short)
    model["cpu_single_question_ms"] = [predict(agent, state_for(cases[i]), short)[1] for i in range(12)]
    report["models"][name] = model
    (HERE / "followup-results.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    print(name, {k: (v['english']['correct'], v['english']['total'], v['english']['false_execute']) for k,v in model.items() if isinstance(v, dict)}, 'cpu ms', statistics.median(model['cpu_single_question_ms']), flush=True)
    del agent
    gc.collect()
