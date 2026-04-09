import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { join } from "path";

/**
 * GET /api/scorer
 *
 * Returns scorer model metadata + training history for the dashboard.
 * Reads from the scorer_model directory in the Email project.
 */

const SCORER_DIR = join(process.env.HOME || "/tmp", "Desktop/Email/scorer_model");

export async function GET() {
  try {
    // Read metadata
    let metadata = null;
    try {
      const raw = await readFile(join(SCORER_DIR, "metadata.json"), "utf-8");
      metadata = JSON.parse(raw);
    } catch {
      // No metadata file
    }

    // Read training history
    let history: Record<string, unknown>[] = [];
    try {
      const raw = await readFile(join(SCORER_DIR, "history.jsonl"), "utf-8");
      history = raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      // No history file
    }

    if (!metadata && history.length === 0) {
      return NextResponse.json({
        error: "No scorer model found. Run train_scorer.py first.",
      }, { status: 404 });
    }

    return NextResponse.json({ metadata, history });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to load scorer data";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
