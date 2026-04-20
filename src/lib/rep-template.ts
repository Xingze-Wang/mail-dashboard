// Fill rep-identity placeholders in a draft. Python scrapers generate the
// full email body with {{REP_NAME}} / {{REP_WECHAT}} tokens; the server
// substitutes the assigned rep's actual identity. Back-compat: if the
// placeholders aren't present, the draft is returned unchanged (legacy
// Python builds pre-dating this contract).

export function fillRepPlaceholders(
  draft: { subject: string; html: string },
  rep: { sender_name: string | null; wechat_id: string | null } | null,
): { subject: string; html: string } {
  const name = rep?.sender_name || "Leo";
  const wechat = rep?.wechat_id || "Lorenserus1";

  const sub = (s: string) =>
    s
      .replaceAll("{{REP_NAME}}", name)
      .replaceAll("{{REP_WECHAT}}", wechat);

  return {
    subject: sub(draft.subject),
    html: sub(draft.html),
  };
}

export function hasRepPlaceholders(html: string): boolean {
  return html.includes("{{REP_NAME}}") || html.includes("{{REP_WECHAT}}");
}
