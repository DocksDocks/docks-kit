// Declarations of the `@oh-my-pi/pi-tui/text/width` 19.2.1 exports that talk
// uses (plan #251 G7, #248 D3b). `cli/tsconfig.json` maps the module name to
// this file, so no host package is installed. omp supplies the module at run
// time; `cli/talk/ui/host.ts` loads it and checks each export by type. The
// signatures copy `src/text/width.ts` of the npm package.

/** Cells `text` occupies on a terminal row. */
export declare function visibleWidth(text: string): number;

/**
 * `text` cut to at most `width` cells, ending in `ellipsis` when cut (the
 * ellipsis counts toward the width; `""` omits it). `pad` fills to exactly
 * `width`. Default `ellipsis`: `…`; default `pad`: `false`.
 */
export declare function truncate(
  text: string,
  width: number,
  ellipsis?: string,
  pad?: boolean,
): string;

/** `text` wrapped to `width` cells per row, by words; `\n` ends a row. */
export declare function wrap(text: string, width: number): string[];
