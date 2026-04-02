import DOMPurify from "dompurify";

export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ALLOWED_TAGS: [
      "a", "b", "i", "u", "em", "strong", "p", "br", "div", "span",
      "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li",
      "table", "thead", "tbody", "tr", "td", "th", "img",
      "blockquote", "pre", "code", "hr", "style",
    ],
    ALLOWED_ATTR: [
      "href", "src", "alt", "style", "class", "target", "rel",
      "width", "height", "border", "cellpadding", "cellspacing",
      "align", "valign", "bgcolor", "color",
    ],
  });
}
