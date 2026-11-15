"""Fresh synthetic cases after selecting the short transcript framing. Not real-user validation."""
import gc
import json
from evaluate import HERE, REVISION, baseline, predict, metrics, torch, laya
from huggingface_hub import snapshot_download

torch.set_num_threads(4)
cases = json.loads((HERE / "holdout.json").read_text())
questions = json.loads((HERE / "followup-results.json").read_text())["schemas"]["short"]
patterns = [prefix + name for prefix in ("", "multilingual/", "typed-decisions/") for name in ("rl_agent_config.json", "model.safetensors", "tokenizer/*", "encoder/*")]
snapshot = snapshot_download("convaiinnovations/laya", revision=REVISION, allow_patterns=patterns, local_files_only=True)
report = {"revision": REVISION, "questions": questions, "baseline_correct": sum(baseline(c) == c["expected"] for c in cases), "total": len(cases), "models": {}}
for name, subfolder in (("english", None), ("multilingual", "multilingual"), ("typed-decisions", "typed-decisions")):
    agent = laya.load(snapshot, subfolder=subfolder, device="cuda")
    rows = []
    for case in cases:
        state = "\n".join(f"{k}: {case[k]}" for k in ("history", "user", "tool_output", "assistant") if k in case)
        result, ms = predict(agent, state, questions)
        rows.append({"id": case["id"], "expected": case["expected"], "latency_ms": ms, "result": result})
    report["models"][name] = {"rows": rows, "metrics": metrics(rows, "normal")}
    print(name, report["models"][name]["metrics"], flush=True)
    del agent
    gc.collect()
    torch.cuda.empty_cache()
(HERE / "holdout-results.json").write_text(json.dumps(report, indent=2) + "\n")
