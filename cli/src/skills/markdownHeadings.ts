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
 * The visible text of a heading's rendered content. The parser passes inline
 * HTML through as raw HTML, so Bun's HTML tokenizer (`HTMLRewriter`,
 * https://bun.sh/docs/runtime/html-rewriter) splits it: only its text chunks
 * count, so tags and comments give no text. Character references are decoded,
 * and runs of whitespace become one space.
 */
function visibleText(html: string): string {
  const chunks: Array<string> = [];
  new HTMLRewriter()
    .onDocument({
      text: (chunk) => {
        chunks.push(chunk.text);
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
