/**
 * A scan of the real Markdown headings of a text, from Bun's built-in CommonMark
 * parser (`Bun.markdown`, https://bun.sh/docs/runtime/markdown). The parser calls
 * the `heading` callback only for a heading block, so a heading line inside a
 * code block, an HTML block, or a paragraph does not count, and one in a list
 * item or a block quote does. Run as a script, the file reads
 * `{ "texts": [...], "title": "..." }` on stdin and writes the scans as JSON, for
 * a caller that does not run under Bun.
 */

/** The headings of one text: how many have the text `title`, and which hold raw inline HTML. */
export interface HeadingScan {
  /** The number of headings without raw inline HTML whose text is the title. */
  readonly count: number;
  /** The 1-based position of each heading that holds raw inline HTML. */
  readonly htmlHeadings: ReadonlyArray<number>;
}

/**
 * The start of a CommonMark raw HTML construct: an open tag, a closing tag, a
 * comment, a processing instruction, a declaration, or a CDATA section
 * (CommonMark 0.31.2, 6.6, https://spec.commonmark.org/0.31.2/#raw-html).
 */
const RAW_HTML =
  /^(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>|<!-->|<!--->|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![A-Za-z][^>]*>|<!\[CDATA\[[\s\S]*?\]\]>)/;

interface Chunk {
  readonly text: string;
  code: boolean;
}

/**
 * The chunks at the end of `chunks` whose texts join to `length` characters, or
 * null when no such run exists. The parser emits an element's text chunks just
 * before its callback, and the callback's `children` is their join.
 */
function trailing(chunks: ReadonlyArray<Chunk>, length: number): ReadonlyArray<Chunk> | null {
  let total = 0;
  let start = chunks.length;
  while (start > 0 && total < length) {
    start -= 1;
    total += chunks[start]?.text.length ?? 0;
  }
  return total === length ? chunks.slice(start) : null;
}

/**
 * The heading scan of each of `texts`. The parser gives raw inline HTML to the
 * `text` callback as its own chunk, as it gives plain text, so a chunk that
 * starts with a raw HTML construct and is not inside a code span marks its
 * heading. A heading without raw HTML counts when its text, with each run of
 * whitespace as one space, is `title`; the parser has decoded the character
 * references.
 */
export function scanHeadings(texts: ReadonlyArray<string>, title: string): Array<HeadingScan> {
  return texts.map((text) => {
    const chunks: Array<Chunk> = [];
    const htmlHeadings: Array<number> = [];
    let headings = 0;
    let count = 0;
    Bun.markdown.render(text, {
      text: (chunk) => {
        chunks.push({ text: chunk, code: false });
        return chunk;
      },
      codespan: (children) => {
        for (const chunk of trailing(chunks, children.length) ?? []) chunk.code = true;
        return children;
      },
      heading: (children) => {
        headings += 1;
        const own = trailing(chunks, children.length);
        if (own === null || own.some((chunk) => !chunk.code && RAW_HTML.test(chunk.text))) {
          htmlHeadings.push(headings);
        } else if (children.replace(/\s+/g, " ").trim() === title) {
          count += 1;
        }
        return children;
      },
    });
    return { count, htmlHeadings };
  });
}

if (import.meta.main) {
  const { texts, title } = JSON.parse(await Bun.stdin.text()) as {
    readonly texts: ReadonlyArray<string>;
    readonly title: string;
  };
  process.stdout.write(JSON.stringify(scanHeadings(texts, title)));
}
