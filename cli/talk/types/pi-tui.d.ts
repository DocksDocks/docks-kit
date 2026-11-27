// Declarations of the `@oh-my-pi/pi-tui` 19.2.1 exports that talk uses
// (plan #251 G7, #248 D3b). `cli/tsconfig.json` maps the module name to this
// file, so no host package is installed. omp supplies the module at run time;
// `cli/talk/ui/host.ts` loads it and checks each export by type. The
// signatures copy `src/types.ts`, `src/node.ts`, `src/reactive.ts`, and
// `src/element.ts` of the npm package.

/** A node of the reactive UI tree. talk builds nodes only with `jsx`. */
export declare class UiNode {
  private constructor();
  /** The node kind, such as `col`, `text`, `input`, `editor`, or `picker`. */
  readonly kind: string;
}

/** What a node factory, a component, or a child expression yields. */
export type JSXNode =
  | UiNode
  | readonly JSXNode[]
  | (() => JSXNode)
  | string
  | number
  | boolean
  | null
  | undefined;

/** A tracked read of a reactive value. */
export type Accessor<T> = () => T;

/** Writable reactive state: call to read (tracked), `set`/`update` to write, `peek` to read untracked. */
export interface Signal<T> extends Accessor<T> {
  set(value: T): void;
  update(fn: (value: T) => T): void;
  peek(): T;
}

/** Options of `signal`: `equals: false` notifies on every write. */
export interface ReactiveOptions<T> {
  equals?: ((previous: T, next: T) => boolean) | false;
}

/** One element: a lowercase `type` is a node kind; a function is a component. */
export declare function jsx(
  type: unknown,
  props: Readonly<Record<string, unknown>>,
  key?: string,
): JSXNode;

/** Reactive state. */
export declare function signal<T>(value: T, options?: ReactiveOptions<T>): Signal<T>;

/** Whether `value` is a `UiNode`. */
export declare function isUiNode(value: unknown): value is UiNode;
