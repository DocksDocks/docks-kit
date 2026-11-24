/**
 * The count of real Markdown headings with one text, from Bun's built-in
 * CommonMark parser (`Bun.markdown`, https://bun.sh/docs/runtime/markdown). The
 * parser calls the `heading` callback only for a heading block, so a heading line
 * inside a code block, an HTML block, or a paragraph does not count, and one in a
 * list item or a block quote does. Run as a script, the file reads
 * `{ "texts": [...], "title": "..." }` on stdin and writes the counts as JSON,
 * for a caller that does not run under Bun.
 */

/** The number of real headings whose text is `title`, for each of `texts`. */
export function countHeadings(texts: ReadonlyArray<string>, title: string): Array<number> {
  return texts.map((text) => {
    let count = 0;
    Bun.markdown.render(text, {
      heading: (children) => {
        if (children.trim() === title) count += 1;
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
