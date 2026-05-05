// Static viewer for the attack catalog. No framework, no build step.
// Reads index.json (a list of attack ids) and fetches each ../attacks/<id>.md.
// All rendering uses DOM methods + textContent — no innerHTML on any
// untrusted strings, since the markdown files are user-contributed.

const FALLBACK_INDEX = [
  "are-you-gpt", "dan-do-anything-now", "document-injection", "encoded-payload",
  "financial-bait", "grandma-exploit", "ignore-previous-instructions", "legal-bait",
  "multi-turn-escalation", "role-play-extraction", "system-prompt-leak",
  "training-data-extraction"
];

const $ = (s) => document.querySelector(s);
const list = $("#list");
const search = $("#search");
const catSel = $("#category");
const sevSel = $("#severity");
const countEl = $("#count");

let attacks = [];

async function load() {
  let ids = FALLBACK_INDEX;
  try {
    const r = await fetch("index.json");
    if (r.ok) ids = await r.json();
  } catch {}
  const loaded = await Promise.all(
    ids.map(async (id) => {
      const r = await fetch(`../attacks/${id}.md`);
      if (!r.ok) return null;
      return parseAttack(await r.text(), id);
    })
  );
  attacks = loaded.filter(Boolean).sort((a, b) =>
    sevRank(b.severity) - sevRank(a.severity) || a.id.localeCompare(b.id)
  );
  populateCategories();
  render();
}

function parseAttack(raw, id) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  const fm = parseFrontmatter(m[1]);
  return { ...fm, id: fm.id || id, prompt: m[2].trim() };
}

function parseFrontmatter(text) {
  const lines = text.split("\n");
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (!kv) continue;
    const [, k, rest] = kv;
    if (rest === "|") {
      const block = [];
      i++;
      while (i < lines.length && (lines[i].startsWith("  ") || lines[i] === "")) {
        block.push(lines[i].replace(/^ {2}/, ""));
        i++;
      }
      i--;
      out[k] = block.join("\n").trim();
    } else if (rest === "") {
      const arr = [];
      while (i + 1 < lines.length && lines[i + 1].startsWith("  - ")) {
        arr.push(lines[++i].slice(4).trim());
      }
      out[k] = arr;
    } else {
      out[k] = rest.replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

function sevRank(s) {
  return { critical: 4, high: 3, medium: 2, low: 1 }[s] || 0;
}

function populateCategories() {
  const cats = [...new Set(attacks.map((a) => a.category))].sort();
  for (const c of cats) {
    const o = document.createElement("option");
    o.value = c;
    o.textContent = c;
    catSel.appendChild(o);
  }
}

// Build a DOM node for one attack. textContent everywhere — no innerHTML.
function renderAttack(a) {
  const article = document.createElement("article");
  article.className = "attack";

  const head = document.createElement("div");
  head.className = "attack-head";
  head.appendChild(span("attack-title", a.title));
  head.appendChild(span(`badge sev-${a.severity}`, a.severity));
  head.appendChild(span("badge cat", a.category));
  head.appendChild(span("attack-id", a.id));
  article.appendChild(head);

  const desc = document.createElement("p");
  desc.className = "attack-desc";
  desc.textContent = a.description;
  article.appendChild(desc);

  const expected = document.createElement("div");
  expected.className = "expected";
  expected.appendChild(expectedBlock("Safe behavior", a.expected_safe_behavior));
  expected.appendChild(expectedBlock("Unsafe behavior", a.expected_unsafe_behavior));
  article.appendChild(expected);

  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Show prompt";
  details.appendChild(summary);
  const pre = document.createElement("pre");
  pre.textContent = a.prompt;
  details.appendChild(pre);
  article.appendChild(details);

  if (Array.isArray(a.references) && a.references.length) {
    const refs = document.createElement("div");
    refs.className = "refs";
    refs.appendChild(document.createTextNode("refs: "));
    a.references.forEach((u, i) => {
      if (i > 0) refs.appendChild(document.createTextNode(" · "));
      const link = document.createElement("a");
      link.href = u;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = u;
      refs.appendChild(link);
    });
    article.appendChild(refs);
  }
  return article;
}

function span(cls, text) {
  const el = document.createElement("span");
  el.className = cls;
  el.textContent = text;
  return el;
}

function expectedBlock(title, body) {
  const wrap = document.createElement("div");
  const h = document.createElement("h4");
  h.textContent = title;
  wrap.appendChild(h);
  wrap.appendChild(document.createTextNode(body));
  return wrap;
}

function render() {
  const q = search.value.trim().toLowerCase();
  const cat = catSel.value;
  const sev = sevSel.value;
  const filtered = attacks.filter((a) => {
    if (cat && a.category !== cat) return false;
    if (sev && a.severity !== sev) return false;
    if (q && !`${a.id} ${a.title} ${a.description}`.toLowerCase().includes(q)) return false;
    return true;
  });
  countEl.textContent = `${filtered.length} of ${attacks.length}`;
  list.replaceChildren(...filtered.map(renderAttack));
}

[search, catSel, sevSel].forEach((el) => el.addEventListener("input", render));
load();
