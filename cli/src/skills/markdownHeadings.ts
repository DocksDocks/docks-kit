/**
 * The count of real Markdown headings with one text, from Bun's built-in
 * CommonMark parser (`Bun.markdown`, https://bun.sh/docs/runtime/markdown). The
 * parser calls the `heading` callback only for a heading block, so a heading line
 * inside a code block, an HTML block, or a paragraph does not count, and one in a
 * list item or a block quote does. Run as a script, the file reads
 * `{ "texts": [...], "title": "..." }` on stdin and writes the counts as JSON,
 * for a caller that does not run under Bun.
 */

/** The named character references that `decodeReferences` knows. */
const NAMED_REFERENCES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

/** Decode the named references above and the decimal and hex numeric references; leave any other `&` text as it is. */
function decodeReferences(text: string): string {
  return text.replace(
    /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/g,
    (reference, decimal?: string, hex?: string, name?: string) => {
      if (name !== undefined) return NAMED_REFERENCES[name] ?? reference;
      const code = decimal !== undefined ? Number(decimal) : Number.parseInt(hex ?? "", 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "\ufffd";
    },
  );
}

/**
 * The elements that HTML renders as a block, a list item, or a table part, and
 * `br`: their start and end break a line (HTML rendering,
 * https://html.spec.whatwg.org/multipage/rendering.html, 15.3). An inline
 * element such as `span` gives no break, so `<span>Re</span>port` stays one word.
 */
const BREAKING_ELEMENTS = [
  "html, body, address, blockquote, center, dialog, div, figure, figcaption, footer, form",
  "header, hr, legend, listing, main, p, plaintext, pre, search, xmp",
  "article, aside, h1, h2, h3, h4, h5, h6, hgroup, nav, section",
  "dir, dd, dl, dt, menu, ol, ul, li, fieldset, details, summary, optgroup, option",
  "table, caption, colgroup, col, thead, tbody, tfoot, tr, td, th, br",
].join(", ");

/**
 * The elements that HTML does not render (`display: none` in the same section):
 * they give no break, and their text does not count.
 */
const HIDDEN_ELEMENTS =
  "area, base, basefont, datalist, head, link, meta, noembed, noframes, param, rp, script, style, template, title";

/**
 * The visible text of a heading's rendered content. The parser passes inline
 * HTML through as raw HTML, so Bun's HTML tokenizer (`HTMLRewriter`,
 * https://bun.sh/docs/runtime/html-rewriter) splits it: only its text chunks
 * count, so tags and comments give no text, the text inside a hidden element is
 * dropped, and the start and end of each breaking element give a space, so words
 * on two sides of a `<br>` stay apart. Character references are decoded, and
 * runs of whitespace become one space.
 */
function visibleText(html: string): string {
  const chunks: Array<string> = [];
  let hidden = 0;
  new HTMLRewriter()
    .on(BREAKING_ELEMENTS, {
      element: (element) => {
        chunks.push(" ");
        if (element.canHaveContent) {
          element.onEndTag(() => {
            chunks.push(" ");
          });
        }
      },
    })
    .on(HIDDEN_ELEMENTS, {
      element: (element) => {
        if (!element.canHaveContent) return;
        hidden += 1;
        element.onEndTag(() => {
          hidden -= 1;
        });
      },
    })
    .onDocument({
      text: (chunk) => {
        if (hidden === 0) chunks.push(chunk.text);
      },
    })
    .transform(html);
  return decodeReferences(chunks.join("")).replace(/\s+/g, " ").trim();
}

/** The number of real headings whose visible text is `title`, for each of `texts`. */
export function countHeadings(texts: ReadonlyArray<string>, title: string): Array<number> {
  return texts.map((text) => {
    let count = 0;
    Bun.markdown.render(text, {
      heading: (children) => {
        if (visibleText(children) === title) count += 1;
        return children;
      },
    });
    return count;
  });
}

if (import.meta.main) {
  const { texts, title } = JSON.parse(await Bun.stdin.text()) as {
    readonly texts: ReadonlyArray<string>;
    readonly title: string;
  };
  process.stdout.write(JSON.stringify(countHeadings(texts, title)));
}
