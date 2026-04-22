"""
Compute Interest Scorer — trains a sentence-transformer classifier
to predict whether a paper's author will be interested in compute support.

Training labels are OUTCOME-based only (sales priors are NOT used as labels):
  - WeChat added OR email clicked -> label = 1
  - everything else                -> label = 0

Sales corrections (lead_corrections table) inform other things:
  - low_quality_email -> email-quality scorer training
  - wrong_author / wrong_direction -> we re-target the lead, no label impact
  - bad_compute / good_lead -> tracked for admin monitoring (sales calibration),
    NOT used as training labels — sales seeing an abstract isn't reliable
    ground truth for "will need compute" or "will convert".

Input: title + abstract
Output: score 0-1 (probability of interest)

Usage:
  python train_scorer.py                    # Train from local data
  python train_scorer.py --export model/    # Train and export model
  python train_scorer.py --predict "title" "abstract"  # Score a paper
"""

import json
import os
import sys
import argparse
import pickle  # Used for local model serialization only
from pathlib import Path
from datetime import datetime

import numpy as np
from sentence_transformers import SentenceTransformer
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import cross_val_score, cross_val_predict
from sklearn.metrics import classification_report, precision_recall_fscore_support, roc_auc_score

# --- Config ---

SCRIPT_DIR = Path(__file__).parent
TRAINING_FILE = SCRIPT_DIR / "training_data.jsonl"
MODEL_DIR = SCRIPT_DIR / "scorer_model"
EMBEDDER_NAME = "all-MiniLM-L6-v2"  # Fast, good quality, 384-dim

# Supabase config (optional, for fetching click/wechat signals)
SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")


# --- Data loading ---

def load_jsonl_data():
    """Load training data from the scanner's JSONL file."""
    if not TRAINING_FILE.exists():
        print(f"  Warning: {TRAINING_FILE} not found")
        return []

    data = []
    with open(TRAINING_FILE) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            data.append(d)
    print(f"  Loaded {len(data)} records from training_data.jsonl")
    return data


def load_click_signals():
    """Fetch email click statuses from Supabase. Returns {email: best_status}."""
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("  No Supabase config, skipping click signals")
        return {}

    try:
        from supabase import create_client
        sb = create_client(SUPABASE_URL, SUPABASE_KEY)

        result = sb.table("emails").select("to,status").execute()
        signals = {}
        priority = {"clicked": 3, "delivered": 2, "sent": 1, "bounced": 0, "complained": 0}

        for row in result.data or []:
            email = (row.get("to") or "").lower()
            status = row.get("status", "sent")
            if not email:
                continue
            current = signals.get(email)
            if current is None or priority.get(status, 0) > priority.get(current, 0):
                signals[email] = status

        print(f"  Loaded {len(signals)} email statuses from Supabase")
        clicked = sum(1 for s in signals.values() if s == "clicked")
        delivered = sum(1 for s in signals.values() if s == "delivered")
        print(f"     Clicked: {clicked}, Delivered: {delivered}")
        return signals
    except Exception as e:
        print(f"  Supabase error: {e}")
        return {}


def load_wechat_signals():
    """Fetch WeChat-added arxiv_ids from Supabase."""
    if not SUPABASE_URL or not SUPABASE_KEY:
        return set()

    try:
        from supabase import create_client
        sb = create_client(SUPABASE_URL, SUPABASE_KEY)

        result = sb.table("brief_lookups").select("arxiv_id").eq("added_wechat", True).execute()
        ids = {row["arxiv_id"] for row in (result.data or []) if row.get("arxiv_id")}
        print(f"  Loaded {len(ids)} WeChat-added papers from Supabase")
        return ids
    except Exception as e:
        print(f"  Supabase WeChat error: {e}")
        return set()


def load_corrections():
    """
    Map arxiv_id -> dict of correction signals from sales:
      { 'bad_compute': N, 'good_lead': N, 'wrong_author': N, ... }
    Returns {arxiv_id: counts_dict}.
    """
    if not SUPABASE_URL or not SUPABASE_KEY:
        return {}
    try:
        from supabase import create_client
        sb = create_client(SUPABASE_URL, SUPABASE_KEY)
        # Join lead_corrections -> pipeline_leads to get arxiv_id.
        # PostgREST embedding: lead_corrections?select=type,pipeline_leads(arxiv_id)
        result = (
            sb.table("lead_corrections")
            .select("type,pipeline_leads(arxiv_id)")
            .execute()
        )
        out = {}
        for row in result.data or []:
            ax = (row.get("pipeline_leads") or {}).get("arxiv_id")
            t = row.get("type")
            if not ax or not t:
                continue
            d = out.setdefault(ax, {})
            d[t] = d.get(t, 0) + 1
        print(f"  Loaded corrections for {len(out)} papers from Supabase")
        return out
    except Exception as e:
        print(f"  Supabase corrections error: {e}")
        return {}


def load_lead_emails():
    """Map arxiv_id to author_email from pipeline_leads."""
    if not SUPABASE_URL or not SUPABASE_KEY:
        return {}

    try:
        from supabase import create_client
        sb = create_client(SUPABASE_URL, SUPABASE_KEY)

        result = sb.table("pipeline_leads").select("arxiv_id,author_email").execute()
        mapping = {}
        for row in result.data or []:
            if row.get("arxiv_id") and row.get("author_email"):
                mapping[row["arxiv_id"]] = row["author_email"].lower()
        print(f"  Loaded {len(mapping)} arxiv-to-email mappings")
        return mapping
    except Exception as e:
        print(f"  Supabase leads error: {e}")
        return {}


# --- Label assignment ---

def assign_labels(jsonl_data, click_signals, wechat_ids, lead_emails, corrections=None):
    """
    Lead-quality labels come from OUTCOME signals only — not sales priors.

    Why: sales sees a paper's abstract and makes a guess about whether that
    person needs compute. Sales is good at judging some things (whether the
    email writeup sounds human, whether we got the right author) but NOT
    great at guessing whether a stranger needs compute or will convert.
    Treating their bad_compute / good_lead flags as labels would overfit to
    their priors instead of learning from real outcomes.

    Outcome signals (binary label = 1 if any positive, else 0):
      WeChat added           positive  (strongest — actual conversion)
      Email clicked          positive  (mild interest)
      Email replied          positive  (planned for future hookup)

    Negative implicit:
      Email sent + bounced   negative  (handled at sample-filter time)
      Email sent, none of above → 0

    Sales corrections are NOT used here. They're surfaced separately:
      - low_quality_email → email-quality scorer training
      - wrong_author / wrong_direction → labeling fixes (we re-target)
      - bad_compute / good_lead → admin monitoring only, NOT training labels
        (these would bias the model toward sales's prior)

    The `corrections` dict is still passed in so we can print stats about
    sales activity per training run, but it does not influence labels.
    """
    samples = []
    stats = {
        "label_1": 0,
        "label_0": 0,
        "wechat_signal": 0,
        "click_signal": 0,
        "sales_bad_compute_for_info": 0,
        "sales_good_lead_for_info": 0,
        "sales_bad_but_actually_converted": 0,  # interesting — sales was wrong
        "sales_good_but_no_conversion": 0,      # also interesting — sales was wrong
    }
    corrections = corrections or {}

    for d in jsonl_data:
        arxiv_id = d.get("arxiv_id", "")
        title = d.get("title", "")
        abstract = d.get("abstract", "")
        text = f"{title} [SEP] {abstract}"

        wechat_hit = arxiv_id in wechat_ids
        click_hit = False
        if arxiv_id in lead_emails:
            click_hit = click_signals.get(lead_emails[arxiv_id]) == "clicked"

        if wechat_hit: stats["wechat_signal"] += 1
        if click_hit:  stats["click_signal"] += 1

        # Binary outcome label
        label = 1 if (wechat_hit or click_hit) else 0
        stats["label_1" if label == 1 else "label_0"] += 1

        # Track where sales diverges from outcome (not used for training, just monitoring)
        corr = corrections.get(arxiv_id, {})
        if corr.get("bad_compute", 0) > 0:
            stats["sales_bad_compute_for_info"] += 1
            if wechat_hit:
                stats["sales_bad_but_actually_converted"] += 1
        if corr.get("good_lead", 0) > 0:
            stats["sales_good_lead_for_info"] += 1
            if not (wechat_hit or click_hit):
                stats["sales_good_but_no_conversion"] += 1

        samples.append((text, float(label)))

    print(f"\n  Outcome-based label stats:")
    for k, v in stats.items():
        print(f"     {k}: {v}")
    if stats["sales_bad_but_actually_converted"] > 0 or stats["sales_good_but_no_conversion"] > 0:
        print(f"\n  ℹ️  Sales-vs-outcome disagreement (not used for training, just monitoring):")
        print(f"     sales said bad_compute but converted: {stats['sales_bad_but_actually_converted']}")
        print(f"     sales said good_lead but no conversion: {stats['sales_good_but_no_conversion']}")
        print(f"     → these are good calibration data for admin to review.")

    return samples


# --- Training ---

def train(samples, model_dir, jsonl_data=None):
    """Embed texts with sentence-transformer, train logistic regression."""
    jsonl_data = jsonl_data or []
    texts = [s[0] for s in samples]
    labels = np.array([s[1] for s in samples])
    binary_labels = (labels >= 0.5).astype(int)

    print(f"\n  Loading embedder: {EMBEDDER_NAME}...")
    embedder = SentenceTransformer(EMBEDDER_NAME)

    print(f"  Embedding {len(texts)} texts...")
    embeddings = embedder.encode(texts, show_progress_bar=True, batch_size=64)
    print(f"  Embedding shape: {embeddings.shape}")

    print(f"\n  Training classifier...")
    clf = LogisticRegression(max_iter=1000, class_weight="balanced", C=1.0)

    scores = cross_val_score(clf, embeddings, binary_labels, cv=5, scoring="f1")
    print(f"  5-fold CV F1: {scores.mean():.3f} (+/- {scores.std():.3f})")

    # Cross-val predictions for per-sample analysis
    cv_preds = cross_val_predict(clf, embeddings, binary_labels, cv=5)
    cv_probs = cross_val_predict(clf, embeddings, binary_labels, cv=5, method="predict_proba")

    clf.fit(embeddings, binary_labels)

    preds = clf.predict(embeddings)
    probs = clf.predict_proba(embeddings)[:, 1]
    print(f"\n  Training set report:")
    print(classification_report(binary_labels, preds, target_names=["no_compute", "needs_compute"]))

    # Compute detailed metrics
    prec, rec, f1, _ = precision_recall_fscore_support(binary_labels, cv_preds, average="binary")
    try:
        auc = roc_auc_score(binary_labels, cv_probs[:, 1])
    except Exception:
        auc = 0.0

    # Score distribution (for histogram)
    score_bins = np.histogram(probs, bins=20, range=(0, 1))
    score_distribution = [
        {"bin": f"{score_bins[1][i]:.2f}-{score_bins[1][i+1]:.2f}", "count": int(score_bins[0][i])}
        for i in range(len(score_bins[0]))
    ]

    # Gemini vs Scorer comparison (per sample)
    gemini_confs = []
    scorer_scores = []
    comparison_samples = []
    for i, d in enumerate(jsonl_data):
        gc = d.get("gemini_confidence", 0)
        ss = float(probs[i])
        gemini_confs.append(gc)
        scorer_scores.append(ss)
        diff = abs(gc - ss)
        if diff > 0.3:  # Big disagreement
            comparison_samples.append({
                "title": d.get("title", "")[:80],
                "gemini": round(gc, 2),
                "scorer": round(ss, 2),
                "diff": round(diff, 2),
                "label": int(binary_labels[i]),
            })

    comparison_samples.sort(key=lambda x: -x["diff"])
    comparison_samples = comparison_samples[:20]  # Top 20 disagreements

    # Save
    model_dir.mkdir(parents=True, exist_ok=True)
    with open(model_dir / "classifier.pkl", "wb") as f:
        pickle.dump(clf, f)

    meta = {
        "embedder": EMBEDDER_NAME,
        "n_samples": len(samples),
        "n_positive": int(binary_labels.sum()),
        "n_negative": int((1 - binary_labels).sum()),
        "cv_f1_mean": float(scores.mean()),
        "cv_f1_std": float(scores.std()),
        "cv_precision": float(prec),
        "cv_recall": float(rec),
        "cv_auc": float(auc),
        "trained_at": datetime.now().isoformat(),
        "label_distribution": {
            "wechat_1.0": int((labels == 1.0).sum()),
            "clicked_0.8": int((labels == 0.8).sum()),
            "gemini_pos_0.5": int((labels == 0.5).sum()),
            "negative_0.0": int((labels == 0.0).sum()),
        },
        "score_distribution": score_distribution,
        "gemini_vs_scorer": {
            "correlation": float(np.corrcoef(gemini_confs, scorer_scores)[0, 1]) if len(gemini_confs) > 1 else 0,
            "mean_gemini": float(np.mean(gemini_confs)),
            "mean_scorer": float(np.mean(scorer_scores)),
            "disagreements": comparison_samples,
        },
    }
    with open(model_dir / "metadata.json", "w") as f:
        json.dump(meta, f, indent=2)

    # Append to training history
    history_file = model_dir / "history.jsonl"
    history_entry = {
        "trained_at": meta["trained_at"],
        "n_samples": meta["n_samples"],
        "cv_f1": meta["cv_f1_mean"],
        "cv_precision": meta["cv_precision"],
        "cv_recall": meta["cv_recall"],
        "cv_auc": meta["cv_auc"],
        "embedder": EMBEDDER_NAME,
    }
    with open(history_file, "a") as f:
        f.write(json.dumps(history_entry) + "\n")

    print(f"\n  Model saved to {model_dir}/")
    print(f"  AUC: {auc:.3f} | Precision: {prec:.3f} | Recall: {rec:.3f}")

    # Upload to dashboard
    dashboard_url = os.environ.get("DASHBOARD_URL", "https://qiji-pipeline.vercel.app")
    try:
        import requests
        resp = requests.post(
            f"{dashboard_url}/api/scorer",
            json=meta,
            timeout=10,
        )
        if resp.status_code in (200, 201):
            print(f"  Dashboard synced")
        else:
            print(f"  Dashboard sync failed: {resp.status_code}")
    except Exception as e:
        print(f"  Dashboard sync failed: {e}")

    return embedder, clf


# --- Prediction ---

def load_model(model_dir):
    embedder = SentenceTransformer(EMBEDDER_NAME)
    with open(model_dir / "classifier.pkl", "rb") as f:
        clf = pickle.load(f)
    return embedder, clf


def predict(embedder, clf, title, abstract):
    text = f"{title} [SEP] {abstract}"
    emb = embedder.encode([text])
    prob = clf.predict_proba(emb)[0]
    pred = clf.predict(emb)[0]
    return {
        "needs_compute": bool(pred),
        "confidence": float(prob[1]),
        "score": float(prob[1]),
    }


# --- Main ---

def main():
    parser = argparse.ArgumentParser(description="Train compute interest scorer")
    parser.add_argument("--export", type=str, default=str(MODEL_DIR), help="Model output dir")
    parser.add_argument("--predict", nargs=2, metavar=("TITLE", "ABSTRACT"), help="Score a paper")
    args = parser.parse_args()

    model_dir = Path(args.export)

    if args.predict:
        title, abstract = args.predict
        print(f"  Scoring: {title[:60]}...")
        embedder, clf = load_model(model_dir)
        result = predict(embedder, clf, title, abstract)
        print(f"  Score: {result['score']:.3f}")
        print(f"  Needs compute: {result['needs_compute']}")
        return

    print("=" * 50)
    print("Compute Interest Scorer - Training")
    print("=" * 50)

    print("\nLoading data...")
    jsonl_data = load_jsonl_data()
    click_signals = load_click_signals()
    wechat_ids = load_wechat_signals()
    lead_emails = load_lead_emails()
    corrections = load_corrections()

    if not jsonl_data:
        print("No training data found")
        sys.exit(1)

    print("\nAssigning labels...")
    samples = assign_labels(jsonl_data, click_signals, wechat_ids, lead_emails, corrections)

    train(samples, model_dir, jsonl_data)

    print("\n" + "=" * 50)
    print("Done. Run with --predict to score papers.")
    print("=" * 50)


if __name__ == "__main__":
    main()
