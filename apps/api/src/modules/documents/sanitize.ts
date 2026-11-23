import sanitizeHtml from 'sanitize-html';

/**
 * Document bodies are rendered as HTML in other members' browsers, so they are sanitised on the SERVER with a
 * strict allowlist (the editor's output is never trusted). No scripts, styles, event handlers, iframes or
 * javascript: URLs; links are forced to rel=noopener noreferrer.
 */
export function sanitizeDocumentHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ['h1', 'h2', 'h3', 'h4', 'p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 's', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span'],
    allowedAttributes: { a: ['href', 'title', 'target', 'rel'], th: ['colspan', 'rowspan'], td: ['colspan', 'rowspan'], code: ['class'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesAppliedToAttributes: ['href'],
    allowProtocolRelative: false,
    transformTags: { a: (tag, attribs) => ({ tagName: 'a', attribs: { ...attribs, rel: 'noopener noreferrer', target: '_blank' } }) },
    disallowedTagsMode: 'discard',
  });
}
