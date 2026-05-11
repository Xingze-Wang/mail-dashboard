function normalizeName(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-zA-Z一-鿿\s]/g, " ").toLowerCase().replace(/\s+/g, " ").trim();
}
function tokens(s) { return normalizeName(s).split(/\s+/).filter(Boolean); }
function nameMatch(needle, hay) {
  const n = tokens(needle);
  const h = new Set(tokens(hay));
  if (n.length === 0) return false;
  return n.every((t) => {
    if (h.has(t)) return true;
    if (t.length === 1) { for (const ht of h) if (ht.startsWith(t)) return true; }
    if (t.length > 1) { for (const ht of h) if (ht.length === 1 && t.startsWith(ht)) return true; }
    return false;
  });
}

const cases = [
  ["Hongyuze Cao", "Cao Hongyuze", true, "Chinese name reorder"],
  ["Cao Hongyuze", "Hongyuze Cao", true, "reverse of above"],
  ["H. Cao", "Hongyuze Cao", true, "initial → full"],
  ["Hongyuze Cao", "H. Cao", true, "full → initial"],
  ["Lin Zhang", "Lin Zhang", true, "exact"],
  ["Yuan Wang", "Yuanzhi Wang", false, "Yuan ≠ Yuanzhi (shard-24 misjoin)"],
  ["Yuxin Liu", "Yuxing Liu", false, "Yuxin ≠ Yuxing (shard-24 misjoin)"],
  ["Ruibin Min", "Rui Min", false, "Ruibin ≠ Rui (shard-24 misjoin)"],
  ["Bo Tang", "Boyan Tang", false, "Bo ≠ Boyan"],
  ["Jiarong Li", "Jiarui Li", false, "Jiarong ≠ Jiarui (shard-13 case)"],
];

let passed = 0, failed = 0;
for (const [needle, hay, expected, label] of cases) {
  const actual = nameMatch(needle, hay);
  const ok = actual === expected;
  if (ok) passed++; else failed++;
  console.log(`${ok ? "✓" : "✗"} ${label.padEnd(36)} "${needle}" vs "${hay}" → ${actual} (expected ${expected})`);
}
console.log(`\n${passed} passed, ${failed} failed`);
