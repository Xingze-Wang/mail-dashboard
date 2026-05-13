/**
 * Pure helpers for clustering rep edits by embedding similarity.
 * No DB access here — caller fetches data + embeddings, passes in arrays.
 */

export interface EditItem {
  id: string;        // lead_id
  vec: number[];     // embedding (1536-dim)
}

export interface Cluster {
  centroid: number[];
  members: EditItem[];
}

/** Cosine similarity of two equal-length vectors. */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error(`vector dim mismatch ${a.length} vs ${b.length}`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Mean of vectors (elementwise). */
function mean(vecs: number[][]): number[] {
  if (vecs.length === 0) return [];
  const dim = vecs[0].length;
  const out = new Array<number>(dim).fill(0);
  for (const v of vecs) {
    for (let i = 0; i < dim; i++) out[i] += v[i];
  }
  for (let i = 0; i < dim; i++) out[i] /= vecs.length;
  return out;
}

/**
 * Greedy single-linkage clustering by cosine similarity.
 * O(n²) — fine for n ≤ ~100 (per-rep monthly edits).
 *
 * @param items items to cluster (each has id + vec)
 * @param threshold minimum cosine to assign to existing cluster
 */
export function clusterEdits(items: EditItem[], threshold: number): Cluster[] {
  const clusters: Cluster[] = [];
  for (const item of items) {
    let best: { cluster: Cluster; sim: number } | null = null;
    for (const c of clusters) {
      const sim = cosine(item.vec, c.centroid);
      if (sim >= threshold && (!best || sim > best.sim)) {
        best = { cluster: c, sim };
      }
    }
    if (best) {
      best.cluster.members.push(item);
      best.cluster.centroid = mean(best.cluster.members.map((m) => m.vec));
    } else {
      clusters.push({ centroid: [...item.vec], members: [item] });
    }
  }
  return clusters;
}

/** The member whose vec is closest (highest cosine) to the centroid. */
export function pickMedoid(members: EditItem[], centroid: number[]): EditItem {
  if (members.length === 0) throw new Error("pickMedoid on empty cluster");
  let bestSim = -Infinity;
  let best = members[0];
  for (const m of members) {
    const s = cosine(m.vec, centroid);
    if (s > bestSim) {
      bestSim = s;
      best = m;
    }
  }
  return best;
}

/** Average pairwise cosine within a cluster — a tightness metric. */
export function clusterTightness(members: EditItem[]): number {
  if (members.length < 2) return 1;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      sum += cosine(members[i].vec, members[j].vec);
      n++;
    }
  }
  return n > 0 ? sum / n : 1;
}
