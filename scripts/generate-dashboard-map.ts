/**
 * The dashboard map: every signed-in screen with its route, its name as the member sees it,
 * and the controls on it (buttons, fields, tabs, settings rows), read from the source with
 * Babel's parser (TypeScript 7 ships no JS compiler API). The assistant searches it to write "where do I click" guides with
 * the real labels and a link to the screen. Labels come from the ⌘K page registry
 * (`dashboard/lib/palette-pages.ts`, kept complete by `verify:palette-coverage`), else the
 * page header, else the route.
 *
 *   pnpm dashboard-map:generate      # writes src/modules/assistant-docs/dashboard-map.generated.json
 *   pnpm verify:dashboard-map        # fails when the file is stale
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DASH = join(ROOT, "dashboard");
const APP = join(DASH, "app/(dashboard)");
export const MAP_PATH = join(ROOT, "src/modules/assistant-docs/dashboard-map.generated.json");

export interface Screen {
  route: string;
  scope: "biz" | "org";
  label: string;
  section: string;
  controls: string[];
  /** The same controls by the card they sit in, in page order; title null = outside any card. */
  groups: Array<{ title: string | null; controls: string[] }>;
  /** Card and section titles: places a guide looks within. Never controls. */
  headings: string[];
  /** Labels from a declared catalogue (`data-map-options`): each is also a control. */
  options?: string[];
}

const LABEL_TAGS = new Set([
  "Button",
  "SubmitButton",
  "RailLink",
  "RailButton",
  "DropdownMenuItem",
  "TabsTrigger",
  "Link",
  "ActionButton",
  "ConfirmDialog",
  "AlertDialogAction",
  "MoreSection",
  "SettingsLinkRow",
  "SettingRow",
  "SettingsCard",
  "RecordCard",
  "SectionCard",
  "Field",
  "PageHeader",
  "SettingsPage",
  "ToggleAnswer",
  "SelectAnswer",
  "FieldLabel",
  "CardTitle",
  "DialogTitle",
  "SheetTitle",
  "h2",
  "h3",
  "h4",
  "label",
]);
/** Object keys whose string value is a visible label: option lists, card and row data arrays. */
const LABEL_KEYS = new Set(["label", "title", "heading"]);
/** Row builders called with their label first, e.g. `configRow("Excess payments", …)`. */
const ROW_CALL = /(?:Row|row)$/;
const LABEL_PROPS = new Set([
  "label",
  "title",
  "heading",
  "placeholder",
  "ariaLabel",
  "aria-label",
  "confirmLabel",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name === "page.tsx") out.push(p);
  }
  return out;
}

export function routeOf(pageFile: string): string {
  const segs = relative(APP, dirname(pageFile))
    .split("/")
    .filter((s) => s && !/^\(.*\)$/.test(s))
    .map((s) => (s === "[biz]" ? "{business}" : s.replace(/^\[(.+)\]$/, "{$1}")));
  return `/${segs.join("/")}`.replace(/\/$/, "") || "/";
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const useful = (s: string) =>
  s.length >= 2 && s.length <= 80 && /[A-Za-z]/.test(s) && !/^[{(<]/.test(s) && !codeLike(s);

/**
 * CSS classes or an identifier, not words a member reads: every token is lower-case with no
 * spaces inside and at least one carries `-`, `:`, `_`, `/` or `[` (`mt-4 border-t`,
 * `hover:bg-muted`, `auto_topup`), or the whole string is one camelCase identifier.
 */
export function codeLike(s: string): boolean {
  if (/^[a-z]+[A-Z][A-Za-z0-9]*$/.test(s)) return true;
  const tokens = s.trim().split(/\s+/);
  return (
    tokens.every((t) => /^[a-z0-9!.%#()[\]/:_-]+$/.test(t)) &&
    tokens.some((t) => /[a-z0-9][-:_/[][a-z0-9[]/.test(t) || /^-/.test(t))
  );
}

type Node = { type: string; [k: string]: unknown };

const nameOf = (n: Node | undefined): string => {
  if (!n) return "";
  if (n.type === "JSXIdentifier") return n.name as string;
  if (n.type === "JSXMemberExpression") return nameOf(n.property as Node);
  return "";
};

/** Every literal a prop can take: both branches of `a ? "x" : "y"`, both sides of `a ?? "x"`. */
export const literals = (v: Node | null | undefined): string[] =>
  v ? labelValues(evaluate(v, emptyCtx(""))) : [];

// ---- Static values: what a computed label can read, from the file and the props it is given.

/** Any value at all. */
const UNKNOWN = Symbol("unknown");
/** A prop given a value we cannot read: it reads as set (`product={product}` is edit mode). */
const DEFINED = Symbol("defined");
type Obj = { obj: Node; ctx: Ctx };
type V = string | number | boolean | null | undefined | typeof UNKNOWN | typeof DEFINED | Obj;

export interface Ctx {
  file: string;
  /** Variable initialisers by name, every scope in the file. */
  decls: Map<string, Node[]>;
  /** Type aliases by name. */
  types: Map<string, Node>;
  /** Components by name ("default" for the default export): their props parameter. */
  params: Map<string, Node | undefined>;
  /** The rendered component's props, as the call site gives them. */
  props: Map<string, V[]>;
  busy: Set<string>;
}

const each = (n: unknown, fn: (x: Node) => void) => {
  if (!n || typeof n !== "object") return;
  if (Array.isArray(n)) return n.forEach((x) => each(x, fn));
  fn(n as Node);
  for (const [k, v] of Object.entries(n))
    if (k !== "loc" && k !== "start" && k !== "end" && typeof v === "object") each(v, fn);
};

const isFn = (n: Node | undefined) =>
  !!n && /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(n.type);

// Declarations are read-only after the first walk: share them across calls on one AST.
const declCache = new WeakMap<object, Pick<Ctx, "decls" | "types" | "params">>();

export function emptyCtx(file: string, ast?: { program: Node }): Ctx {
  const shared = ast && declCache.get(ast);
  if (shared) return { file, ...shared, props: new Map(), busy: new Set() };
  const ctx: Ctx = {
    file,
    decls: new Map(),
    types: new Map(),
    params: new Map(),
    props: new Map(),
    busy: new Set(),
  };
  each(ast?.program, (n) => {
    const id = n.id as Node | undefined;
    if (n.type === "VariableDeclarator" && id?.type === "Identifier" && n.init) {
      const name = id.name as string;
      if (isFn(n.init as Node)) ctx.params.set(name, ((n.init as Node).params as Node[])[0]);
      else ctx.decls.set(name, [...(ctx.decls.get(name) ?? []), n.init as Node]);
    } else if (n.type === "FunctionDeclaration" && id) {
      ctx.params.set(id.name as string, (n.params as Node[])[0]);
    } else if (n.type === "ExportDefaultDeclaration" && isFn(n.declaration as Node)) {
      ctx.params.set("default", ((n.declaration as Node).params as Node[])[0]);
    } else if (n.type === "TSTypeAliasDeclaration" && id) {
      ctx.types.set(id.name as string, n.typeAnnotation as Node);
    }
  });
  if (ast) declCache.set(ast, { decls: ctx.decls, types: ctx.types, params: ctx.params });
  return ctx;
}

const opaque = (v: V) => v === UNKNOWN || v === DEFINED;
const isObj = (v: V): v is Obj => typeof v === "object" && v !== null;
/** true / false, or null when it could be either. */
const truth = (v: V): boolean | null =>
  v === UNKNOWN ? null : v === DEFINED || isObj(v) ? true : Boolean(v);

const uniq = (vs: V[]): V[] => [...new Set(vs)].slice(0, 16);

/** The string literals of a type (`"plan" | "addon"`, or an alias of one); null if not one. */
function unionOf(t: Node | undefined, ctx: Ctx, depth = 0): string[] | null {
  if (!t || depth > 4) return null;
  if (t.type === "TSParenthesizedType") return unionOf(t.typeAnnotation as Node, ctx, depth);
  if (t.type === "TSLiteralType") {
    const l = t.literal as Node;
    return l.type === "StringLiteral" ? [l.value as string] : null;
  }
  if (t.type === "TSUnionType") {
    const parts = (t.types as Node[]).map((x) => unionOf(x, ctx, depth + 1));
    return parts.every(Boolean) ? (parts.flat() as string[]) : null;
  }
  if (t.type === "TSTypeReference" && (t.typeName as Node).type === "Identifier")
    return unionOf(ctx.types.get((t.typeName as Node).name as string), ctx, depth + 1);
  return null;
}

const STRING_FNS: Record<string, (s: string) => string> = {
  toLowerCase: (s) => s.toLowerCase(),
  toUpperCase: (s) => s.toUpperCase(),
  trim: (s) => s.trim(),
};

/** Every value an expression can take, read statically; UNKNOWN where it depends on data. */
export function evaluate(n: Node | null | undefined, ctx: Ctx): V[] {
  if (!n) return [UNKNOWN];
  switch (n.type) {
    case "StringLiteral":
    case "NumericLiteral":
    case "BooleanLiteral":
      return [n.value as V];
    case "NullLiteral":
      return [null];
    case "JSXExpressionContainer":
    case "ParenthesizedExpression":
    case "TSNonNullExpression":
    case "TSSatisfiesExpression":
      return evaluate(n.expression as Node, ctx);
    case "TSAsExpression": {
      const vs = evaluate(n.expression as Node, ctx);
      return (vs.some(opaque) && unionOf(n.typeAnnotation as Node, ctx)) || vs;
    }
    case "ObjectExpression":
      return [{ obj: n, ctx }];
    case "TemplateLiteral": {
      const quasis = (n.quasis as Array<{ value: { cooked: string } }>).map((q) => q.value.cooked);
      let acc: V[] = [quasis[0] ?? ""];
      (n.expressions as Node[]).forEach((e, i) => {
        const vs = evaluate(e, ctx);
        acc = uniq(
          acc.flatMap((a) =>
            vs.map((v) =>
              typeof a === "string" && (typeof v === "string" || typeof v === "number")
                ? `${a}${v}${quasis[i + 1] ?? ""}`
                : UNKNOWN,
            ),
          ),
        );
      });
      return acc;
    }
    case "ConditionalExpression": {
      const ts = evaluate(n.test as Node, ctx).map(truth);
      return uniq([
        ...(ts.some((t) => t !== false) ? evaluate(n.consequent as Node, ctx) : []),
        ...(ts.some((t) => t !== true) ? evaluate(n.alternate as Node, ctx) : []),
      ]);
    }
    case "LogicalExpression": {
      const left = evaluate(n.left as Node, ctx);
      const op = n.operator as string;
      const go = (v: V) =>
        op === "??"
          ? v === UNKNOWN
            ? null
            : v != null
          : op === "||"
            ? truth(v)
            : truth(v) === null
              ? null
              : !truth(v);
      // go(v): true = the left side is the result, false = the right side is, null = either.
      const out = left.filter((v) => go(v) !== false);
      return uniq(
        left.some((v) => go(v) !== true) ? [...out, ...evaluate(n.right as Node, ctx)] : out,
      );
    }
    case "UnaryExpression":
      if (n.operator !== "!") return [UNKNOWN];
      return uniq(
        evaluate(n.argument as Node, ctx).map((v) => (truth(v) === null ? UNKNOWN : !truth(v))),
      );
    case "BinaryExpression": {
      const op = n.operator as string;
      if (!["===", "!==", "==", "!="].includes(op)) return [UNKNOWN];
      const [l, r] = [evaluate(n.left as Node, ctx), evaluate(n.right as Node, ctx)];
      if ([...l, ...r].some((v) => opaque(v) || isObj(v))) return [UNKNOWN];
      const eq = l.flatMap((a) => r.map((b) => (op.length === 3 ? a === b : a == b)));
      return uniq(eq.map((e) => (op.startsWith("!") ? !e : e)));
    }
    case "Identifier": {
      const name = n.name as string;
      if (name === "undefined") return [undefined];
      const prop = ctx.props.get(name);
      if (prop) return prop;
      const inits = ctx.decls.get(name);
      if (!inits) return libConst(name, ctx);
      if (ctx.busy.has(name)) return [UNKNOWN];
      ctx.busy.add(name);
      const out = uniq(inits.flatMap((i) => evaluate(i, ctx)));
      ctx.busy.delete(name);
      return out;
    }
    case "MemberExpression":
    case "OptionalMemberExpression": {
      const prop = n.property as Node;
      const keys = n.computed ? evaluate(prop, ctx) : [prop.name as string];
      return uniq(
        evaluate(n.object as Node, ctx).flatMap((o): V[] => {
          if (o == null) return [undefined];
          if (!isObj(o)) return [UNKNOWN];
          const entries = (o.obj.properties as Node[]).filter((p) => p.type === "ObjectProperty");
          const keyOf = (p: Node) => {
            const k = p.key as Node;
            return k.type === "Identifier" && !p.computed ? (k.name as string) : literal(k);
          };
          return keys.flatMap((k) => {
            if (opaque(k) || isObj(k))
              return exactKeys
                ? [UNKNOWN]
                : entries.flatMap((p) => evaluate(p.value as Node, o.ctx));
            const hit = entries.find((p) => keyOf(p) === String(k));
            return hit ? evaluate(hit.value as Node, o.ctx) : [undefined];
          });
        }),
      );
    }
    case "CallExpression":
    case "OptionalCallExpression": {
      const callee = n.callee as Node;
      const fn =
        callee.type.endsWith("MemberExpression") && !callee.computed
          ? STRING_FNS[(callee.property as Node).name as string]
          : undefined;
      if (!fn) return [UNKNOWN];
      return uniq(
        evaluate(callee.object as Node, ctx).map((v) => (typeof v === "string" ? fn(v) : UNKNOWN)),
      );
    }
  }
  return [UNKNOWN];
}

/** A label value read through a label map or a choice (`LABELS.x`, `a ? "One" : "Two"`). */
const COMPUTED_LABEL = new Set([
  "MemberExpression",
  "OptionalMemberExpression",
  "ConditionalExpression",
  "LogicalExpression",
]);

const libBusy = new Set<string>();
/** While reading a computed label: a map indexed by an unknown key yields nothing, not every value. */
let exactKeys = false;
/** A constant imported from `@/lib/…` (a label map such as `FAILED_CHANGE_LABELS`). */
function libConst(name: string, ctx: Ctx): V[] {
  if (!ctx.file || !existsSync(ctx.file)) return [UNKNOWN];
  for (const d of parseFile(ctx.file).program.body as Node[]) {
    if (d.type !== "ImportDeclaration") continue;
    const spec = (d.source as Node).value as string;
    if (!spec.startsWith("@/lib/")) continue;
    const sp = (d.specifiers as Node[]).find(
      (x) => x.type === "ImportSpecifier" && (x.local as Node).name === name,
    );
    if (!sp) continue;
    const base = join(DASH, spec.slice(2));
    const target = [`${base}.ts`, `${base}.tsx`].find((c) => existsSync(c));
    if (!target) return [UNKNOWN];
    const lib = emptyCtx(target, parseFile(target));
    const exported = (sp.imported as Node).name as string;
    const key = `${target}#${exported}`;
    if (!lib.decls.has(exported) || libBusy.has(key)) return [UNKNOWN];
    libBusy.add(key);
    const out = uniq(lib.decls.get(exported)!.flatMap((i) => evaluate(i, lib)));
    libBusy.delete(key);
    return out;
  }
  return [UNKNOWN];
}

const labelValues = (vs: V[]) => vs.filter((v): v is string => typeof v === "string");

/** Templates in an action label that read no value; printed by the generator. */
export const unresolved = new Set<string>();

/** The labels an action prop can show. A template it cannot read is reported, not dropped. */
function actionLabels(v: Node | null | undefined, ctx: Ctx): string[] {
  if (!v) return [];
  each(v, (t) => {
    if (t.type !== "TemplateLiteral" || !(t.expressions as Node[]).length) return;
    if (evaluate(t, ctx).some((x) => typeof x !== "string")) {
      const line = (t.loc as { start: { line: number } } | undefined)?.start.line;
      unresolved.add(`${relative(ROOT, ctx.file)}:${line}`);
    }
  });
  return labelValues(evaluate(v, ctx));
}

/**
 * A rendered component's props: what the call site passes, `undefined` (or the default) for the
 * rest, and a literal union type for a value we cannot read (`kind: Kind` → each kind).
 */
function bindProps(param: Node | undefined, passed: Map<string, V[]>, spread: boolean, ctx: Ctx) {
  const out = new Map<string, V[]>();
  if (param?.type !== "ObjectPattern") return out;
  const typed = (param.typeAnnotation as Node | undefined)?.typeAnnotation as Node | undefined;
  const typeOf = (key: string) => {
    const t =
      typed?.type === "TSTypeReference"
        ? ctx.types.get((typed.typeName as Node).name as string)
        : typed;
    const m = t?.type === "TSTypeLiteral" ? (t.members as Node[]) : [];
    const sig = m.find((x) => x.type === "TSPropertySignature" && (x.key as Node).name === key);
    return (sig?.typeAnnotation as Node | undefined)?.typeAnnotation as Node | undefined;
  };
  for (const p of param.properties as Node[]) {
    if (p.type !== "ObjectProperty" || (p.key as Node).type !== "Identifier") continue;
    const key = (p.key as Node).name as string;
    const value = p.value as Node;
    const local = value.type === "AssignmentPattern" ? (value.left as Node) : value;
    if (local.type !== "Identifier") continue;
    let vs: V[] = passed.has(key)
      ? passed.get(key)!.map((v) => (v === UNKNOWN ? DEFINED : v))
      : spread
        ? [UNKNOWN]
        : value.type === "AssignmentPattern"
          ? evaluate(value.right as Node, ctx)
          : [undefined];
    const union = vs.some(opaque) ? unionOf(typeOf(key), ctx) : null;
    if (union) vs = union;
    out.set(local.name as string, vs);
  }
  return out;
}

const literal = (v: Node | null | undefined): string | null => {
  if (!v) return null;
  if (v.type === "StringLiteral") return v.value as string;
  if (v.type === "JSXExpressionContainer") return literal(v.expression as Node);
  if (v.type === "TemplateLiteral" && (v.expressions as unknown[]).length === 0) {
    return (v.quasis as Array<{ value: { cooked: string } }>)[0]?.value.cooked ?? null;
  }
  return null;
};

/** The literal `title` of the page's PageHeader / SettingsPage, if it has one. */
export function headerTitle(file: string): string | null {
  const m = /<(?:PageHeader|SettingsPage)\b[^>]*?\btitle="([^"]+)"/s.exec(
    readFileSync(file, "utf8"),
  );
  return m ? clean(m[1]!) : null;
}

const SINGULAR: Record<string, string> = {
  invoices: "Invoice",
  customers: "Customer",
  subscriptions: "Subscription",
  credit_notes: "Credit note",
  transactions: "Transaction",
  payment_intents: "Payment",
  receipts: "Receipt",
  disputes: "Dispute",
  payment_requests: "Payment request",
  gateway_requests: "Gateway request",
  gateway_webhooks: "Gateway webhook",
  events: "Event",
  emails: "Email",
  logs: "Request log",
  webhooks: "Webhook endpoint",
};

/** A card, panel or dialog: its controls are one group, named by its title. */
const CARD_TAGS = new Set([
  "RecordCard",
  "SettingsCard",
  "SectionCard",
  "MoreSection",
  "FormCard",
  "Card",
  "DialogContent",
  "SheetContent",
]);
const TITLE_TAGS = new Set(["CardTitle", "DialogTitle", "SheetTitle", "h2", "h3"]);
/** Headings: they name a place on the screen (a guide's `within`), never a control. */
const HEADING_TAGS = new Set([...TITLE_TAGS, "h4"]);

const textOf = (node: Node): string =>
  clean(
    (node.children as Node[])
      .map((c) => (c.type === "JSXText" ? (c.value as string) : (literal(c) ?? "")))
      .join(" "),
  );

/** A card's literal `title`/`heading`, else the text of its first title element. */
function cardTitle(node: Node): string | null {
  const open = node.openingElement as Node;
  for (const a of open.attributes as Node[]) {
    if (a.type !== "JSXAttribute") continue;
    const key = nameOf(a.name as Node) || ((a.name as Node).name as string);
    if (key === "title" || key === "heading") {
      const v = literal(a.value as Node);
      if (v) return clean(v);
    }
  }
  let found: string | null = null;
  const look = (n: unknown) => {
    if (found || !n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(look);
    const x = n as Node;
    if (
      x.type === "JSXElement" &&
      TITLE_TAGS.has(nameOf((x.openingElement as Node).name as Node))
    ) {
      const t = textOf(x);
      if (useful(t)) found = t;
      return;
    }
    for (const [k, v] of Object.entries(x)) if (k !== "loc" && typeof v === "object") look(v);
  };
  look(node.children);
  return found;
}

/**
 * Local components a file imports: local name → file and exported name. Not the primitives
 * (`ui/`, `patterns/`) unless `all`: their labels are generic, but their prop types still say
 * which prop is a breadcrumb trail.
 */
function importsOf(
  file: string,
  ast: { program: Node },
  all = false,
): Map<string, { file: string; name: string }> {
  const out = new Map<string, { file: string; name: string }>();
  for (const d of ast.program.body as Node[]) {
    if (d.type !== "ImportDeclaration") continue;
    const spec = (d.source as Node).value as string;
    if (!/^(@\/components|\.{1,2})\//.test(spec)) continue;
    if (!all && (spec.startsWith("@/components/ui/") || spec.startsWith("@/components/patterns/")))
      continue;
    const base = spec.startsWith("@/") ? join(DASH, spec.slice(2)) : resolve(dirname(file), spec);
    const target = [base, `${base}.tsx`, `${base}.ts`, join(base, "index.tsx")].find(
      (c) => existsSync(c) && statSync(c).isFile(),
    );
    if (!target) continue;
    for (const sp of d.specifiers as Node[]) {
      if (sp.type === "ImportNamespaceSpecifier") continue;
      const name =
        sp.type === "ImportDefaultSpecifier" ? "default" : ((sp.imported as Node).name as string);
      out.set((sp.local as Node).name as string, { file: target, name });
    }
  }
  return out;
}

/**
 * What a label is. Only `control` and `option` are things to act on; a heading names a card
 * (a guide's `within`), and a breadcrumb or page title is page chrome, never a control.
 */
export type LabelKind = "control" | "option" | "heading" | "crumb" | "title";
type Labelled = { group: string | null; label: string; kind: LabelKind };

/** `Crumb[]`, optional or not: the page header's breadcrumb trail type. */
function isCrumbs(t: Node | undefined): boolean {
  if (!t) return false;
  if (t.type === "TSTypeAnnotation") return isCrumbs(t.typeAnnotation as Node);
  if (t.type === "TSUnionType") return (t.types as Node[]).some(isCrumbs);
  return (
    t.type === "TSArrayType" &&
    (t.elementType as Node).type === "TSTypeReference" &&
    ((t.elementType as Node).typeName as Node).name === "Crumb"
  );
}

/**
 * A component's props typed `Crumb[]`, read from its declared props type. A component that
 * takes one is a page header frame (`PageHeader`, `SettingsPage`, a create form's frame).
 */
const crumbCache = new Map<string, Set<string>>();
function crumbProps(file: string, name: string): Set<string> {
  const key = `${file}#${name}`;
  const hit = crumbCache.get(key);
  if (hit) return hit;
  const out = new Set<string>();
  crumbCache.set(key, out);
  const ast = parseFile(file);
  const param = emptyCtx(file, ast).params.get(name);
  let t = (param?.typeAnnotation as Node | undefined)?.typeAnnotation as Node | undefined;
  if (t?.type === "TSTypeReference") {
    const ref = (t.typeName as Node).name as string;
    for (const st of ast.program.body as Node[]) {
      const x = st.type === "ExportNamedDeclaration" ? (st.declaration as Node | null) : st;
      if (x?.type === "TSTypeAliasDeclaration" && (x.id as Node).name === ref)
        t = x.typeAnnotation as Node;
      if (x?.type === "TSInterfaceDeclaration" && (x.id as Node).name === ref)
        t = { type: "TSTypeLiteral", members: (x.body as Node).body } as Node;
    }
  }
  const members = t?.type === "TSTypeLiteral" ? (t.members as Node[]) : [];
  for (const m of members)
    if (m.type === "TSPropertySignature" && isCrumbs(m.typeAnnotation as Node))
      out.add((m.key as Node).name as string);
  return out;
}

/**
 * Option lists a screen builds from a catalogue rather than from JSX literals: a provider
 * directory, an integrations directory, the email types, the release-note types. The element that renders the list names its source with
 * `data-map-options="<key>"`, and the map lists the labels the source holds at build time. Only
 * a source that is static in the build belongs here, never a business's own records.
 */
export const OPTION_SOURCES: Record<string, { file: string; labels: () => Promise<string[]> }> = {
  gateways: {
    file: "src/providers/gateway-catalog.ts",
    labels: async () => {
      const { GATEWAYS } = (await import(join(ROOT, "src/providers/gateway-catalog.ts"))) as {
        GATEWAYS: Record<string, { displayName: string }>;
      };
      return Object.values(GATEWAYS).map((g) => g.displayName);
    },
  },
  integrations: {
    file: "src/modules/integrations/catalogue.ts",
    labels: async () => {
      const mod = (await import(join(ROOT, "src/modules/integrations/catalogue.ts"))) as {
        listIntegrations: () => Array<{ label: string }>;
      };
      return mod.listIntegrations().map((i) => i.label);
    },
  },
  "email-types": {
    file: "dashboard/lib/email-types.ts",
    labels: async () => {
      const mod = (await import(join(DASH, "lib/email-types.ts"))) as {
        EMAIL_GROUPS: string[];
        emailTypesInGroup: (g: string) => Array<{ label: string }>;
      };
      return mod.EMAIL_GROUPS.flatMap((g) => mod.emailTypesInGroup(g).map((t) => t.label));
    },
  },
  "release-types": {
    file: "dashboard/lib/release-note-types.ts",
    labels: async () => {
      const mod = (await import(join(DASH, "lib/release-note-types.ts"))) as {
        RELEASE_TYPES: readonly string[];
      };
      return [...mod.RELEASE_TYPES];
    },
  },
};
export const OPTIONS_ATTR = "data-map-options";
let optionLabels: Map<string, string[]> | null = null;
export async function loadOptionSources(): Promise<void> {
  if (optionLabels) return;
  const loaded = new Map<string, string[]>();
  for (const [k, src] of Object.entries(OPTION_SOURCES)) loaded.set(k, await src.labels());
  optionLabels = loaded;
}

// A shared component is imported by many pages: parse each file once (the walk only reads it).
const SKIP_KEYS = new Set([
  "loc",
  "start",
  "end",
  "extra",
  "comments",
  "tokens",
  "leadingComments",
  "trailingComments",
  "innerComments",
]);
const astCache = new Map<string, { program: Node }>();
function parseFile(file: string): { program: Node } {
  let ast = astCache.get(file);
  if (!ast) {
    ast = parse(readFileSync(file, "utf8"), {
      sourceType: "module",
      plugins: ["typescript", "jsx"],
      errorRecovery: true,
    }) as unknown as { program: Node };
    astCache.set(file, ast);
  }
  return ast;
}

/**
 * The group that holds a page's sticky action bar: its submit, cancel and other actions. Not
 * "Actions": a card on the assistant settings screen already has that title.
 */
export const ACTIONS = "Action bar";

/**
 * Frames that draw a form's sticky action bar, and wrappers that hand one its label. Labels come
 * from a prop at the call site (`submit`, the `slot` JSX, `save.label`) or from the frame itself
 * (`fixed`, and `fallback` when the prop has no label), so the generic scan cannot see them.
 */
export const ACTION_FRAMES: Record<
  string,
  {
    file: string;
    fixed: string[];
    submit?: string;
    slot?: string;
    save?: { prop: string; fallback: string };
  }
> = {
  FormFrame: { file: "components/catalog/form-kit.tsx", fixed: ["Cancel"], submit: "submitLabel" },
  // Its own SubFormFrame draws the bar and the Cancel.
  ChargeFrame: { file: "components/charges/charge-takeover.tsx", fixed: [], submit: "submitLabel" },
  SubFormFrame: {
    file: "components/subscriptions/sub-form-frame.tsx",
    fixed: ["Cancel"],
    slot: "primary",
  },
  SettingsColumns: {
    file: "components/settings/settings-layout.tsx",
    fixed: [],
    save: { prop: "save", fallback: "Save" },
  },
};
/** A submit label on any other component (an inline editor's Save) labels its own card. */
const SUBMIT_PROPS = new Set(["submitLabel"]);

/** A frame label must still be in its source, or the map would name a button that is gone. */
export function checkActionFrames(): void {
  for (const [name, f] of Object.entries(ACTION_FRAMES)) {
    const src = readFileSync(join(DASH, f.file), "utf8");
    if (!new RegExp(`export function ${name}\\b`).test(src))
      throw new Error(`${name} is no longer in ${f.file}: update ACTION_FRAMES`);
    for (const l of [...f.fixed, ...(f.save ? [f.save.fallback] : [])])
      if (!src.includes(`>${l}<`) && !src.includes(`"${l}"`))
        throw new Error(`${name} no longer renders "${l}": update ACTION_FRAMES`);
  }
}

/** A button's visible label, each way a ternary in it can read; `<ShortLabel full>` reads full. */
function buttonTexts(node: Node, ctx: Ctx): string[] {
  const of = (c: Node): string[] => {
    if (c.type === "JSXText") return [c.value as string];
    if (c.type === "JSXExpressionContainer") return of(c.expression as Node);
    if (c.type === "ConditionalExpression" || c.type === "LogicalExpression")
      return c.type === "ConditionalExpression"
        ? [...of(c.consequent as Node), ...of(c.alternate as Node)]
        : [...of(c.left as Node), ...of(c.right as Node)];
    if (c.type === "JSXElement") {
      const open = c.openingElement as Node;
      if (nameOf(open.name as Node) === "ShortLabel") {
        const full = (open.attributes as Node[]).find(
          (a) => a.type === "JSXAttribute" && (a.name as Node).name === "full",
        );
        return actionLabels(full?.value as Node, ctx);
      }
      return buttonTexts(c, ctx);
    }
    if (c.type === "JSXFragment") return buttonTexts(c, ctx);
    return actionLabels(c, ctx);
  };
  let out = [""];
  for (const c of node.children as Node[]) {
    const vs = of(c);
    if (!vs.length) continue;
    out = out.flatMap((o) => vs.map((v) => `${o} ${v}`)).slice(0, 8);
  }
  // A pending label ("Saving…") is not a control to name.
  return out.map(clean).filter((t) => useful(t) && !/(…|\.\.\.)$/.test(t));
}

/** The labels of the action bar a frame element draws. */
function frameActions(name: string, open: Node, ctx: Ctx): string[] {
  const f = ACTION_FRAMES[name];
  if (!f) return [];
  const attr = (k: string) =>
    (open.attributes as Node[]).find(
      (a) => a.type === "JSXAttribute" && (a.name as Node).name === k,
    );
  const out: string[] = f.submit ? actionLabels(attr(f.submit)?.value as Node, ctx) : [];
  const slot = f.slot ? attr(f.slot) : undefined;
  if (slot) {
    const look = (n: unknown) => {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) return n.forEach(look);
      const x = n as Node;
      if (x.type === "JSXElement") {
        const tag = nameOf((x.openingElement as Node).name as Node);
        if (tag === "Button" || tag === "SubmitButton")
          return void out.push(...buttonTexts(x, ctx));
      }
      for (const [k, v] of Object.entries(x)) if (k !== "loc" && typeof v === "object") look(v);
    };
    look(slot.value);
  }
  const save = f.save ? attr(f.save.prop) : undefined;
  if (f.save && save) {
    const obj = (save.value as Node | null)?.expression as Node | undefined;
    const label =
      obj?.type === "ObjectExpression"
        ? (obj.properties as Node[]).find(
            (p) => p.type === "ObjectProperty" && (p.key as Node).name === "label",
          )
        : undefined;
    const ls = label ? actionLabels(label.value as Node, ctx) : [];
    out.push(...(ls.length ? ls : [f.save.fallback]));
  }
  return [...out, ...f.fixed];
}

/**
 * Visible labels in source order, each with the card it renders in. A component's labels count
 * where the page renders it (an inline editor inside "Subscription configurations" belongs to
 * that card), two imports deep. `call` is how the parent renders it: a computed action label
 * reads the props it is given (`kind="plan"` → "Create plan").
 */
export function labelsIn(
  file: string,
  inherited: string | null = null,
  depth = 2,
  seen: ReadonlySet<string> = new Set(),
  call?: { name: string; props: Map<string, V[]>; spread: boolean },
  only?: string[],
): Labelled[] {
  if (seen.has(file)) return [];
  const chain = new Set(seen).add(file);
  const ast = parseFile(file);
  const imports =
    depth > 0 ? importsOf(file, ast) : new Map<string, { file: string; name: string }>();
  const ctx = emptyCtx(file, ast);
  if (call) ctx.props = bindProps(ctx.params.get(call.name), call.props, call.spread, ctx);
  // An imported file counts only for what the parent uses: the rendered component (or the names
  // it imports), and the declarations of this file those reach. A shared file's other exports
  // are not on this screen.
  const roots = call ? [call.name] : only;
  const body = roots ? reachable(ast, roots) : (ast.program.body as Node[]);
  const rendered = new Set<string>();
  const out: Labelled[] = [];
  const push = (
    group: string | null,
    v: string | null | undefined,
    kind: LabelKind = "control",
  ) => {
    const label = v ? clean(v) : "";
    if (useful(label)) out.push({ group, label, kind });
  };
  // Page chrome, read by type: the value of a `Crumb[]` prop, what that value is built from
  // (`crumbs`, `[...baseCrumbs, …]`, `ruleCrumbs(biz, "Pause")`), and any `Crumb[]` declaration.
  const allImports = importsOf(file, ast, true);
  const trailOf = (name: string) => {
    const t = allImports.get(name);
    return t ? crumbProps(t.file, t.name) : new Set<string>();
  };
  const refs = (n: Node | undefined): string[] => {
    if (!n) return [];
    if (n.type === "JSXExpressionContainer" || /^TS(As|Satisfies)Expression$/.test(n.type))
      return refs(n.expression as Node);
    if (n.type === "Identifier") return [n.name as string];
    if (n.type === "ArrayExpression")
      return (n.elements as Node[]).flatMap((e) =>
        e?.type === "SpreadElement" ? refs(e.argument as Node) : [],
      );
    if (n.type === "CallExpression") return refs(n.callee as Node);
    if (n.type === "ConditionalExpression")
      return [...refs(n.consequent as Node), ...refs(n.alternate as Node)];
    if (n.type === "LogicalExpression") return [...refs(n.left as Node), ...refs(n.right as Node)];
    return [];
  };
  const skip = new Set<Node>();
  const skipTrail = (v: Node) => {
    skip.add(v);
    for (const r of refs(v)) for (const d of ctx.decls.get(r) ?? []) skip.add(d);
  };
  each(body, (x) => {
    if (x.type === "VariableDeclarator" && isCrumbs((x.id as Node).typeAnnotation as Node))
      skip.add(x);
    if (isFn(x) && isCrumbs(x.returnType as Node)) skip.add(x);
    if (x.type !== "JSXElement") return;
    const open = x.openingElement as Node;
    const trail = trailOf(nameOf(open.name as Node));
    for (const a of open.attributes as Node[])
      if (a.type === "JSXAttribute" && a.value && trail.has((a.name as Node).name as string))
        skipTrail(a.value as Node);
  });
  const chrome = (v: Node, kind: "crumb" | "title", group: string | null) => {
    for (const n of [v, ...refs(v).flatMap((r) => ctx.decls.get(r) ?? [])])
      if (kind === "title") for (const l of labelValues(evaluate(n, ctx))) push(group, l, kind);
      else
        each(n, (x) => {
          const k = x.type === "ObjectProperty" ? (x.key as Node) : null;
          if (k && ((k.name as string) ?? literal(k)) === "label")
            push(group, literal(x.value as Node), kind);
        });
  };
  const visit = (n: unknown, group: string | null) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach((x) => visit(x, group));
    const node = n as Node;
    if (skip.has(node)) return;
    if (node.type === "JSXElement") {
      const open = node.openingElement as Node;
      const name = nameOf(open.name as Node);
      const card = CARD_TAGS.has(name) ? cardTitle(node) : null;
      if (card) push(group, card, "heading");
      const g = card || group;
      const trail = trailOf(name);
      // Label props count on any element (a SelectField's ariaLabel, an Input's aria-label).
      for (const a of open.attributes as Node[]) {
        if (a.type !== "JSXAttribute") continue;
        const key = nameOf(a.name as Node) || ((a.name as Node).name as string);
        if (trail.has(key)) chrome(a.value as Node, "crumb", g);
        // A frame that takes a breadcrumb trail is a page header: its title is the page's.
        else if (trail.size && key === "title") {
          if (a.value) chrome(a.value as Node, "title", g);
          skip.add(a.value as Node);
        } else if (key === OPTIONS_ATTR) {
          const src = literal(a.value as Node);
          const labels = src ? optionLabels?.get(src) : undefined;
          if (!labels)
            throw new Error(
              `${relative(ROOT, file)}: ${OPTIONS_ATTR}="${src}" names no source in OPTION_SOURCES`,
            );
          for (const l of labels) push(g, l, "option");
        } else if (LABEL_PROPS.has(key))
          push(
            g,
            literal(a.value as Node),
            CARD_TAGS.has(name) && (key === "title" || key === "heading") ? "heading" : "control",
          );
        if (SUBMIT_PROPS.has(key) && !ACTION_FRAMES[name])
          for (const l of actionLabels(a.value as Node, ctx)) push(g, l);
      }
      for (const l of frameActions(name, open, ctx)) push(ACTIONS, l);
      if (LABEL_TAGS.has(name))
        push(g, textOf(node), HEADING_TAGS.has(name) ? "heading" : "control");
      const comp = imports.get(name);
      if (comp) {
        rendered.add(`${comp.file}#${comp.name}`);
        const props = new Map<string, V[]>();
        let spread = false;
        for (const a of open.attributes as Node[]) {
          if (a.type !== "JSXAttribute") spread = true;
          else
            props.set(
              (a.name as Node).name as string,
              a.value ? evaluate(a.value as Node, ctx) : [true],
            );
        }
        out.push(...labelsIn(comp.file, g, depth - 1, chain, { name: comp.name, props, spread }));
      }
      visit(open.attributes, g);
      visit(node.children, g);
      return;
    }
    if (node.type === "ObjectProperty") {
      const key = node.key as Node;
      const k = key.type === "Identifier" ? (key.name as string) : literal(key);
      if (k && LABEL_KEYS.has(k)) {
        const lit = literal(node.value as Node);
        if (lit) push(group, lit);
        else if (COMPUTED_LABEL.has((node.value as Node).type)) {
          exactKeys = true;
          const vs = labelValues(evaluate(node.value as Node, ctx));
          exactKeys = false;
          for (const l of vs) if (!/\s[?.:,]$|^#[0-9a-f]{3,8}$/i.test(l)) push(group, l);
        }
      }
    } else if (node.type === "CallExpression") {
      const callee = node.callee as Node;
      if (callee.type === "Identifier" && ROW_CALL.test(callee.name as string))
        push(group, literal((node.arguments as Node[])[0]));
    }
    for (const k in node) {
      if (SKIP_KEYS.has(k)) continue;
      const v = node[k];
      if (v && typeof v === "object") visit(v, group);
    }
  };
  visit(body, inherited);
  // Imported but not rendered as an element here (passed by reference): the labels of what
  // this file uses from it, if this file's own reached code uses it.
  const used = referencedNames(body);
  const byFile = new Map<string, string[]>();
  for (const [local, i] of imports)
    if (used.has(local) && !rendered.has(`${i.file}#${i.name}`))
      byFile.set(i.file, [...(byFile.get(i.file) ?? []), i.name]);
  for (const [f, names] of byFile)
    out.push(...labelsIn(f, inherited, depth - 1, chain, undefined, names));
  return out;
}

/** Names a top-level statement declares ("default" for the default export). */
function declaredBy(st: Node): string[] {
  const d = (st.type === "ExportNamedDeclaration" ? st.declaration : st) as Node | null;
  if (st.type === "ExportDefaultDeclaration") {
    const id = (st.declaration as Node).id as Node | undefined;
    return ["default", ...(id ? [id.name as string] : [])];
  }
  if (!d) return [];
  if (d.type === "FunctionDeclaration" || d.type === "ClassDeclaration")
    return d.id ? [(d.id as Node).name as string] : [];
  if (d.type === "VariableDeclaration")
    return (d.declarations as Node[]).flatMap((v) =>
      (v.id as Node).type === "Identifier" ? [(v.id as Node).name as string] : [],
    );
  return [];
}

const nameOrValue = (n: Node) =>
  n.type === "Identifier" ? (n.name as string) : (n.value as string);

/** Every identifier and JSX tag name under a node. */
function referencedNames(n: unknown, out = new Set<string>()): Set<string> {
  if (!n || typeof n !== "object") return out;
  if (Array.isArray(n)) {
    for (const x of n) referencedNames(x, out);
    return out;
  }
  const x = n as Node;
  if (x.type === "Identifier" || x.type === "JSXIdentifier") out.add(x.name as string);
  for (const [k, v] of Object.entries(x)) if (!SKIP_KEYS.has(k)) referencedNames(v, out);
  return out;
}

/** The top-level statements that `roots` reach through the names they use, in source order. */
function reachable(ast: { program: Node }, roots: string[]): Node[] {
  const body = (ast.program.body as Node[]).filter((st) => st.type !== "ImportDeclaration");
  const owner = new Map<string, Node>();
  for (const st of body) for (const n of declaredBy(st)) owner.set(n, st);
  // `export { Local as Name }`: the exported name reaches the local declaration.
  const alias = new Map<string, string>();
  for (const st of body)
    if (st.type === "ExportNamedDeclaration" && !st.declaration && !st.source)
      for (const sp of st.specifiers as Node[])
        alias.set(nameOrValue(sp.exported as Node), (sp.local as Node).name as string);
  const keep = new Set<Node>();
  const todo = roots.map((r) => alias.get(r) ?? r);
  while (todo.length) {
    const st = owner.get(todo.pop()!);
    if (!st || keep.has(st)) continue;
    keep.add(st);
    todo.push(...referencedNames(st));
  }
  return body.filter((st) => keep.has(st));
}

const titleCase = (s: string) => s.replace(/[-_]/g, " ").replace(/^\w/, (c) => c.toUpperCase());
const singular = (s: string) => titleCase(s.replace(/ies$/, "y").replace(/(?<!s)s$/, ""));

/** Per route, every label the walk read and each kind it was read as: what the audit checks. */
export const labelKinds = new Map<string, Map<string, Set<LabelKind>>>();
/** Per route, the page file it was read from. */
export const pageFileOf = new Map<string, string>();

export async function buildDashboardMap(): Promise<Screen[]> {
  checkActionFrames();
  await loadOptionSources();
  labelKinds.clear();
  pageFileOf.clear();
  const { PALETTE_PAGES, CREATE_PAGES } = (await import(join(DASH, "lib/palette-pages.ts"))) as {
    PALETTE_PAGES: Array<{ scope: "biz" | "org"; path: string; label: string; section: string }>;
    CREATE_PAGES: Array<{ label: string; path: string; section: string }>;
  };
  const screens: Screen[] = [];
  for (const file of walk(APP).sort()) {
    const route = routeOf(file);
    // A catch-all only throws notFound(); it is not a screen.
    if (route.includes("{...")) continue;
    const scope = route.startsWith("/businesses/{business}") ? "biz" : "org";
    const local = scope === "biz" ? route.slice("/businesses/{business}".length) || "/" : route;
    // An anchor entry (`/settings#security`) names one card on the page, not the page.
    const pal = PALETTE_PAGES.find((p) => p.scope === scope && p.path === local);
    const anchor = PALETTE_PAGES.find((p) => p.scope === scope && p.path.split("#")[0] === local);
    const create = scope === "biz" ? CREATE_PAGES.find((c) => `/${c.path}` === local) : undefined;
    const parts = local.split("/").filter(Boolean);
    const segs = parts.filter((s) => !s.startsWith("{"));
    // A record page (`…/invoices/{inv}`) has a dynamic title: name it by what it shows.
    const record = parts.at(-1)?.startsWith("{")
      ? (SINGULAR[parts.at(-2) ?? ""] ?? singular(parts.at(-2) ?? ""))
      : null;
    const label =
      pal?.label ??
      create?.label ??
      record ??
      headerTitle(file) ??
      titleCase(segs.at(-1) ?? "Home");
    const section =
      pal?.section ??
      anchor?.section ??
      create?.section ??
      titleCase(segs[0] ?? (scope === "biz" ? "Business" : "Organization"));
    // An action keeps its label even when it is the screen's name ("Create coupon").
    const all = labelsIn(file);
    pageFileOf.set(route, file);
    const kinds = new Map<string, Set<LabelKind>>();
    for (const l of all) kinds.set(l.label, (kinds.get(l.label) ?? new Set()).add(l.kind));
    labelKinds.set(route, kinds);
    // A heading is a place to look within, kept apart; chrome is dropped. An action keeps its
    // label even when it is the screen's name ("Create coupon").
    const labelled = all.filter(
      (l) =>
        (l.kind === "control" || l.kind === "option") && (l.group === ACTIONS || l.label !== label),
    );
    const headings = [...new Set(all.filter((l) => l.kind === "heading").map((l) => l.label))];
    const options = [...new Set(all.filter((l) => l.kind === "option").map((l) => l.label))];
    const byGroup = new Map<string | null, string[]>();
    for (const { group, label: c } of labelled) {
      const list = byGroup.get(group) ?? [];
      if (!list.includes(c)) list.push(c);
      byGroup.set(group, list);
    }
    // The action bar reads last, as it sits at the foot of the page.
    const actions = byGroup.get(ACTIONS);
    byGroup.delete(ACTIONS);
    if (actions) byGroup.set(ACTIONS, actions);
    const groups = [...byGroup].map(([title, cs]) => ({ title, controls: cs }));
    const controls = [
      ...new Set([
        ...labelled.filter((l) => l.group !== ACTIONS).map((l) => l.label),
        ...(actions ?? []),
      ]),
    ];
    screens.push({
      route,
      scope,
      label,
      section,
      controls,
      groups,
      headings,
      ...(options.length ? { options } : {}),
    });
  }
  // Chrome every screen shares ("Loading", "Reload", "Required") names no screen: drop a label
  // found on more than one screen in six. Action bars and declared options are exempt: "Cancel"
  // is common chrome and still the button a guide must name; an option is listed on purpose.
  const seen = new Map<string, number>();
  for (const s of screens) {
    const own = new Set(s.groups.filter((g) => g.title !== ACTIONS).flatMap((g) => g.controls));
    for (const c of own) seen.set(c, (seen.get(c) ?? 0) + 1);
  }
  const common = screens.length / 6;
  const keep = (c: string) => (seen.get(c) ?? 0) <= common;
  for (const s of screens) {
    const opts = new Set(s.options);
    const kept = (c: string) => keep(c) || opts.has(c);
    s.groups = s.groups
      .map((g) => ({
        title: g.title,
        controls: g.title === ACTIONS ? g.controls : g.controls.filter(kept),
      }))
      .filter((g) => g.controls.length);
    const acts = new Set(s.groups.find((g) => g.title === ACTIONS)?.controls);
    s.controls = s.controls.filter((c) => kept(c) || acts.has(c)).slice(0, 300);
  }
  return screens;
}

export const renderMap = (screens: Screen[]) => `${JSON.stringify(screens, null, 1)}\n`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const screens = await buildDashboardMap();
  writeFileSync(MAP_PATH, renderMap(screens));
  for (const at of [...unresolved].sort())
    console.warn(
      `warning: ${at}: an action label template reads no static value; it is not in the map`,
    );
  console.log(
    `wrote ${relative(ROOT, MAP_PATH)} (${screens.length} screens, ${screens.reduce((n, s) => n + s.controls.length, 0)} controls)`,
  );
}
