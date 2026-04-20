// Canonicalize email so dedup catches obvious aliases.
// Rules applied to ALL providers:
//   - lowercase
//   - trim whitespace
//   - strip "+tag" subaddress (john+work@x.com -> john@x.com)
// Gmail-only:
//   - googlemail.com -> gmail.com
//   - dots in local part are ignored by Gmail (j.o.h.n@gmail.com == john@gmail.com)
//
// We DO NOT canonicalize across .edu / .org domains — those genuinely
// differentiate. Conservative on purpose: false dedup-positives are worse
// than false negatives for sales (worst case: re-prompt a confirmation).

export function canonicalizeEmail(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = String(raw).trim().toLowerCase();
  if (!s.includes("@")) return s;

  let [local, domain] = s.split("@", 2);

  // Strip subaddress on every provider (Gmail, FastMail, ProtonMail, ...).
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);

  // Gmail family canonicalization
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") {
    local = local.replace(/\./g, "");
  }

  return `${local}@${domain}`;
}
