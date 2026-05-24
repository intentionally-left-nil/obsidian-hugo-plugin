import {
	ShortcodeParseError,
	type AstNode,
	type ArgValue,
	type Delim,
	type ShortcodeArgs,
	type ShortcodeNode,
	type TextNode,
} from '../types';
import { locate, tokenize, type Token } from './tokenizer';

/**
 * Parse a markdown body string into an AST of text and shortcode nodes.
 *
 * `pairedNames` lists shortcode names that MUST have a closing tag (e.g.
 * `'gallery'`). For these names, the parser will throw if no closing tag is
 * found. For all other names, a non-self-closing invocation followed by no
 * matching close is treated as a void invocation.
 *
 * Throws `ShortcodeParseError` on malformed shortcodes.
 */
export function parse(source: string, pairedNames: string[] = ['gallery']): AstNode[] {
	const tokens = tokenize(source);
	const ctx: ParseCtx = { source, tokens, pos: 0, pairedNames: new Set(pairedNames) };
	return parseNodes(ctx, null);
}

interface ParseCtx {
	source: string;
	tokens: Token[];
	pos: number;
	pairedNames: Set<string>;
}

function peek(ctx: ParseCtx, offset = 0): Token | null {
	return ctx.tokens[ctx.pos + offset] ?? null;
}

function consume(ctx: ParseCtx): Token | null {
	return ctx.tokens[ctx.pos++] ?? null;
}

/**
 * Parse a sequence of AST nodes. If `closingFor` is non-null, parsing stops
 * when the matching closing tag `{{< /closingFor >}}` is encountered (which
 * is consumed by this function).
 */
function parseNodes(ctx: ParseCtx, closingFor: string | null): AstNode[] {
	const nodes: AstNode[] = [];
	while (ctx.pos < ctx.tokens.length) {
		const tok = peek(ctx);
		if (!tok) break;

		if (tok.kind === 'text') {
			consume(ctx);
			nodes.push(textNode(tok.start, tok.end, tok.value));
			continue;
		}

		if (tok.kind === 'open') {
			// Look ahead: is this an opening shortcode or a closing tag for the parent?
			const after = peek(ctx, 1);
			if (after && after.kind === 'slash') {
				if (closingFor === null) {
					// Stray closing tag — treat as malformed.
					throw makeError(ctx.source, tok.start, 'Unexpected closing shortcode tag');
				}
				// Consume `open slash ident close` and return; caller validates name.
				const closeTag = consumeClosingTag(ctx);
				if (closeTag !== closingFor) {
					throw makeError(
						ctx.source,
						tok.start,
						`Mismatched closing tag: expected </${closingFor}>, got </${closeTag}>`,
					);
				}
				return nodes;
			}
			const node = parseShortcode(ctx);
			nodes.push(node);
			continue;
		}

		// Anything else at top-level (close/equals/string/bare/ident/slash/self-close)
		// is unexpected — text and open are the only valid starts.
		throw makeError(ctx.source, tok.start, `Unexpected token ${tok.kind} outside shortcode`);
	}

	if (closingFor !== null) {
		throw makeError(
			ctx.source,
			ctx.tokens[ctx.tokens.length - 1]?.end ?? ctx.source.length,
			`Unclosed shortcode tag <${closingFor}>: missing {{< /${closingFor} >}}`,
		);
	}

	return nodes;
}

/**
 * Consume `open slash ident close` and return the name.
 */
function consumeClosingTag(ctx: ParseCtx): string {
	const open = consume(ctx);
	if (!open || open.kind !== 'open') throw makeError(ctx.source, open?.start ?? 0, 'Expected open delimiter');
	const slash = consume(ctx);
	if (!slash || slash.kind !== 'slash') throw makeError(ctx.source, slash?.start ?? open.end, 'Expected `/` in closing tag');
	const ident = consume(ctx);
	if (!ident || ident.kind !== 'ident') throw makeError(ctx.source, ident?.start ?? slash.end, 'Expected name in closing tag');
	const close = consume(ctx);
	if (!close || close.kind !== 'close') throw makeError(ctx.source, close?.start ?? ident.end, 'Expected close delimiter in closing tag');
	if (close.delim !== open.delim) {
		throw makeError(ctx.source, open.start, `Mismatched delimiter style: ${open.value} ... ${close.value}`);
	}
	return ident.value;
}

function parseShortcode(ctx: ParseCtx): ShortcodeNode {
	const open = consume(ctx);
	if (!open || open.kind !== 'open') {
		throw makeError(ctx.source, open?.start ?? 0, 'Expected open delimiter');
	}
	const delim: Delim = open.delim ?? '<';

	const nameTok = consume(ctx);
	if (!nameTok || nameTok.kind !== 'ident') {
		throw makeError(ctx.source, nameTok?.start ?? open.end, 'Expected shortcode name');
	}
	const name = nameTok.value;

	const args: ShortcodeArgs = { named: new Map(), positional: [] };
	let selfClosing = false;
	let closeTok: Token;

	for (;;) {
		const tok = peek(ctx);
		if (!tok) {
			throw makeError(ctx.source, open.start, `Unclosed shortcode {{${delim} ${name} ...`);
		}
		if (tok.kind === 'self-close') {
			consume(ctx);
			selfClosing = true;
			const c = consume(ctx);
			if (!c || c.kind !== 'close') {
				throw makeError(ctx.source, c?.start ?? tok.end, 'Expected close delimiter after self-close `/`');
			}
			if (c.delim !== delim) {
				throw makeError(ctx.source, open.start, `Mismatched delimiter style: ${open.value} ... ${c.value}`);
			}
			closeTok = c;
			break;
		}
		if (tok.kind === 'close') {
			consume(ctx);
			if (tok.delim !== delim) {
				throw makeError(ctx.source, open.start, `Mismatched delimiter style: ${open.value} ... ${tok.value}`);
			}
			closeTok = tok;
			break;
		}
		// Otherwise expect an argument.
		parseArg(ctx, args);
	}

	const node: ShortcodeNode = {
		kind: 'shortcode',
		name,
		delim,
		args,
		selfClosing,
		start: open.start,
		end: closeTok.end,
		children: [],
	};

	if (selfClosing) {
		return node;
	}

	// Decide whether this shortcode requires a closing tag. We use two signals:
	// 1. Names in `pairedNames` always require closing tags (throws if missing).
	// 2. Otherwise, peek forward; if the next non-text content is a matching
	//    closing tag or another shortcode (i.e. there's structured inner
	//    content), treat as paired.
	const isKnownPaired = ctx.pairedNames.has(name);
	if (isKnownPaired || looksLikePairedClosing(ctx, name)) {
		node.innerStart = closeTok.end;
		node.children = parseNodes(ctx, name);
		const lastConsumed = ctx.tokens[ctx.pos - 1];
		node.innerEnd = lastConsumed
			? findInnerEnd(ctx, lastConsumed)
			: closeTok.end;
		node.end = lastConsumed?.end ?? node.end;
	}

	return node;
}

function findInnerEnd(ctx: ParseCtx, lastToken: Token): number {
	// `lastToken` is the close `>}}` of the closing tag. Walk back to find the
	// start of the closing tag (`{{<` of `{{< /name >}}`).
	for (let i = ctx.pos - 1; i >= 0; i--) {
		const t = ctx.tokens[i];
		if (t && t.kind === 'open') return t.start;
	}
	return lastToken.start;
}

function looksLikePairedClosing(ctx: ParseCtx, name: string): boolean {
	// Scan ahead through the token stream looking for an opening sequence
	// `open slash ident(=name)` (the start of `{{< /name >}}`). We must skip
	// nested same-named opens so we don't pair with the wrong close.
	let depth = 1;
	let i = ctx.pos;
	while (i < ctx.tokens.length) {
		const t = ctx.tokens[i];
		if (!t) return false;
		if (t.kind !== 'open') {
			i++;
			continue;
		}
		const after = ctx.tokens[i + 1];
		if (after && after.kind === 'slash') {
			const ident = ctx.tokens[i + 2];
			if (ident && ident.kind === 'ident' && ident.value === name) {
				depth--;
				if (depth === 0) return true;
				i += 3;
				continue;
			}
			i++;
			continue;
		}
		// Nested opening of the same name → increase depth.
		const nameTok = ctx.tokens[i + 1];
		if (nameTok && nameTok.kind === 'ident' && nameTok.value === name) {
			depth++;
		}
		i++;
	}
	return false;
}

function parseArg(ctx: ParseCtx, args: ShortcodeArgs): void {
	const first = consume(ctx);
	if (!first) {
		throw new Error('parseArg called at end of stream');
	}

	if (first.kind === 'ident') {
		const eq = peek(ctx);
		if (eq && eq.kind === 'equals') {
			consume(ctx);
			const valTok = consume(ctx);
			if (!valTok) {
				throw makeError(ctx.source, eq.end, 'Expected value after `=`');
			}
			const value = readArgValue(ctx, valTok);
			args.named.set(first.value, value);
			return;
		}
		// No equals → bare positional.
		args.positional.push({ value: first.value });
		return;
	}

	if (first.kind === 'string' || first.kind === 'bare') {
		args.positional.push({ value: first.value });
		return;
	}

	throw makeError(ctx.source, first.start, `Unexpected token ${first.kind} in shortcode arguments`);
}

function readArgValue(ctx: ParseCtx, tok: Token): ArgValue {
	if (tok.kind === 'string' || tok.kind === 'bare' || tok.kind === 'ident') {
		return { value: tok.value };
	}
	throw makeError(ctx.source, tok.start, `Unexpected token ${tok.kind} as shortcode argument value`);
}

function textNode(start: number, end: number, value: string): TextNode {
	return { kind: 'text', start, end, value };
}

function makeError(source: string, offset: number, message: string): ShortcodeParseError {
	const { line, column } = locate(source, offset);
	return new ShortcodeParseError(message, offset, line, column);
}

/* ---------------------------------------------------------------------------
 * Serializer
 * ------------------------------------------------------------------------- */

/**
 * Render a shortcode node back to its source form. Always normalises string
 * values to double quotes; bool-shaped bare values (`true`/`false`) are
 * preserved as bare. Empty-string named args are dropped.
 *
 * For paired tags, callers must serialise inner content separately (we keep
 * the original inner text byte range to splice back in).
 */
export function serializeShortcodeOpen(node: ShortcodeNode): string {
	const open = node.delim === '<' ? '{{<' : '{{%';
	const close = node.delim === '<' ? '>}}' : '%}}';
	const parts: string[] = [open, ' ', node.name];

	for (const v of node.args.positional) {
		parts.push(' ', formatValue(v.value));
	}
	for (const [key, value] of node.args.named) {
		if (value.value === '') continue;
		parts.push(' ', key, '=', formatValue(value.value));
	}

	if (node.selfClosing) {
		parts.push(' /', close);
	} else {
		parts.push(' ', close);
	}
	return parts.join('');
}

export function serializeShortcodeClose(node: ShortcodeNode): string {
	if (node.selfClosing) return '';
	const open = node.delim === '<' ? '{{<' : '{{%';
	const close = node.delim === '<' ? '>}}' : '%}}';
	return `${open} /${node.name} ${close}`;
}

function formatValue(value: string): string {
	if (value === 'true' || value === 'false') return value;
	// Always use double quotes; escape internal `"` and `\`.
	const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
	return `"${escaped}"`;
}

/* ---------------------------------------------------------------------------
 * Edit applicator
 * ------------------------------------------------------------------------- */

export interface Edit {
	start: number;
	end: number;
	replacement: string;
}

/**
 * Apply a list of edits to a source string. Edits must not overlap. Edits are
 * applied right-to-left so byte offsets remain valid.
 */
export function applyEdits(source: string, edits: Edit[]): string {
	if (edits.length === 0) return source;
	const sorted = [...edits].sort((a, b) => b.start - a.start);
	for (let i = 0; i < sorted.length - 1; i++) {
		const cur = sorted[i]!;
		const next = sorted[i + 1]!;
		if (next.end > cur.start) {
			throw new Error(`Overlapping edits: [${next.start}, ${next.end}) and [${cur.start}, ${cur.end})`);
		}
	}
	let out = source;
	for (const edit of sorted) {
		out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
	}
	return out;
}

/* ---------------------------------------------------------------------------
 * AST query helpers
 * ------------------------------------------------------------------------- */

export function findShortcodes(ast: AstNode[], name: string): ShortcodeNode[] {
	const out: ShortcodeNode[] = [];
	walk(ast, (n) => {
		if (n.kind === 'shortcode' && n.name === name) out.push(n);
	});
	return out;
}

export function walk(ast: AstNode[], visit: (node: AstNode) => void): void {
	for (const node of ast) {
		visit(node);
		if (node.kind === 'shortcode') walk(node.children, visit);
	}
}

/**
 * Replace a node's open tag (and only the open tag — inner content is
 * untouched) with new args. Returns an `Edit` for `applyEdits`.
 */
export function editShortcodeArgs(
	source: string,
	node: ShortcodeNode,
	mutate: (args: ShortcodeArgs) => void,
): Edit {
	// Clone args so the in-memory AST stays consistent with the source until
	// the edit is applied.
	const newArgs: ShortcodeArgs = {
		named: new Map(node.args.named),
		positional: [...node.args.positional],
	};
	mutate(newArgs);
	const newNode: ShortcodeNode = { ...node, args: newArgs };

	// Compute the byte range of the *open tag only*, even for paired tags.
	const openEnd = node.selfClosing ? node.end : (node.innerStart ?? node.end);
	const replacement = serializeShortcodeOpen(newNode);
	return { start: node.start, end: openEnd, replacement };
}
