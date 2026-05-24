import { ShortcodeParseError, type Delim } from '../types';

/**
 * Token kinds produced by the shortcode tokenizer.
 *
 * The tokenizer recognises Hugo shortcode delimiter pairs (`{{< … >}}` and
 * `{{% … %}}`) and produces a stream of typed tokens. Anything outside of a
 * delimiter pair is emitted as `Text`.
 *
 * The tokenizer is intentionally narrow: it only knows about the lexical
 * structure of shortcode invocations. It does NOT distinguish figure/gallery
 * vs other shortcode names; that is the parser's job.
 */
export type TokenKind =
	| 'text'
	| 'open'        // {{< or {{%
	| 'close'       // >}} or %}}
	| 'slash'       // / immediately after open (closing tag)
	| 'self-close'  // / immediately before close (self-closing form: /}})
	| 'ident'       // shortcode name or arg key
	| 'equals'      // =
	| 'string'      // quoted value: "..." or '...' or `...`
	| 'bare';       // bare value: e.g. `true`, `123`, `lazy`

export interface Token {
	kind: TokenKind;
	start: number;
	end: number;
	value: string;       // for `text`, `ident`, `string`, `bare` — the meaningful contents
	delim?: Delim;       // set for `open` and `close` tokens
}

const enum Mode {
	Text,
	InsideShortcode,
}

/**
 * Tokenize a string. Throws `ShortcodeParseError` on malformed input
 * (unterminated quote, unclosed delimiter, mismatched delimiter pair).
 */
export function tokenize(source: string): Token[] {
	const tokens: Token[] = [];
	let pos = 0;
	let mode: Mode = Mode.Text;
	let openDelim: Delim | null = null;
	let openStart = 0;

	const len = source.length;

	while (pos < len) {
		if (mode === Mode.Text) {
			const nextOpen = findNextOpen(source, pos);
			if (nextOpen === -1) {
				if (pos < len) {
					tokens.push({ kind: 'text', start: pos, end: len, value: source.slice(pos, len) });
				}
				return tokens;
			}
			if (nextOpen > pos) {
				tokens.push({ kind: 'text', start: pos, end: nextOpen, value: source.slice(pos, nextOpen) });
			}
			// Determine which delimiter style this is (already validated by findNextOpen).
			const ch = source.charCodeAt(nextOpen + 2);
			openDelim = ch === 0x25 /* % */ ? '%' : '<';
			openStart = nextOpen;
			tokens.push({ kind: 'open', start: nextOpen, end: nextOpen + 3, value: source.slice(nextOpen, nextOpen + 3), delim: openDelim });
			pos = nextOpen + 3;
			mode = Mode.InsideShortcode;
			continue;
		}

		// Mode.InsideShortcode
		const ch = source.charCodeAt(pos);

		// Skip whitespace inside a shortcode.
		if (isSpace(ch)) {
			pos++;
			continue;
		}

		// Closing delimiter? Must match the opening delimiter style.
		if (matchesClose(source, pos, openDelim!)) {
			const closeStart = pos;
			tokens.push({ kind: 'close', start: closeStart, end: closeStart + 3, value: source.slice(closeStart, closeStart + 3), delim: openDelim! });
			pos += 3;
			mode = Mode.Text;
			openDelim = null;
			continue;
		}

		// Self-close slash: `/` immediately followed by the matching close.
		if (ch === 0x2f /* / */ && matchesClose(source, pos + 1, openDelim!)) {
			tokens.push({ kind: 'self-close', start: pos, end: pos + 1, value: '/' });
			pos++;
			continue;
		}

		// Closing-tag slash: `/` after an `open` token, before the name.
		if (ch === 0x2f /* / */ && lastNonTextTokenIs(tokens, 'open')) {
			tokens.push({ kind: 'slash', start: pos, end: pos + 1, value: '/' });
			pos++;
			continue;
		}

		// Equals between key and value.
		if (ch === 0x3d /* = */) {
			tokens.push({ kind: 'equals', start: pos, end: pos + 1, value: '=' });
			pos++;
			continue;
		}

		// Quoted strings.
		if (ch === 0x22 /* " */ || ch === 0x27 /* ' */ || ch === 0x60 /* ` */) {
			const tok = consumeString(source, pos, openStart);
			tokens.push(tok);
			pos = tok.end;
			continue;
		}

		// Identifier or bare value.
		if (isIdentStart(ch)) {
			const start = pos;
			while (pos < len && isIdentBody(source.charCodeAt(pos))) pos++;
			const value = source.slice(start, pos);
			// Whether this is `ident` (key/name) or `bare` (value) is decided by the
			// parser; both share the same lexical form. We emit `ident` and let the
			// parser reclassify when it sees `=` follow-on or context.
			tokens.push({ kind: 'ident', start, end: pos, value });
			continue;
		}

		// Anything else (e.g. punctuation in unquoted values) is treated as a bare run.
		const start = pos;
		while (pos < len && !isSpace(source.charCodeAt(pos)) && source.charCodeAt(pos) !== 0x3d /* = */ && !matchesClose(source, pos, openDelim!) && source.charCodeAt(pos) !== 0x22 && source.charCodeAt(pos) !== 0x27 && source.charCodeAt(pos) !== 0x60) {
			pos++;
		}
		if (start === pos) {
			throw makeError(source, pos, `Unexpected character ${JSON.stringify(source[pos])} inside shortcode`);
		}
		tokens.push({ kind: 'bare', start, end: pos, value: source.slice(start, pos) });
	}

	if (mode === Mode.InsideShortcode) {
		throw makeError(source, openStart, `Unterminated shortcode delimiter (started here)`);
	}

	return tokens;
}

function findNextOpen(source: string, from: number): number {
	let i = from;
	while (i < source.length) {
		const idx = source.indexOf('{{', i);
		if (idx === -1) return -1;
		const next = source.charCodeAt(idx + 2);
		if (next === 0x3c /* < */ || next === 0x25 /* % */) return idx;
		// `{{` not followed by `<` or `%` — not a shortcode (could be Hugo template syntax in code blocks etc.). Skip past it.
		i = idx + 2;
	}
	return -1;
}

function matchesClose(source: string, pos: number, delim: Delim): boolean {
	if (pos + 3 > source.length) return false;
	if (delim === '<') {
		return source.charCodeAt(pos) === 0x3e /* > */ && source.charCodeAt(pos + 1) === 0x7d && source.charCodeAt(pos + 2) === 0x7d;
	}
	return source.charCodeAt(pos) === 0x25 /* % */ && source.charCodeAt(pos + 1) === 0x7d && source.charCodeAt(pos + 2) === 0x7d;
}

function lastNonTextTokenIs(tokens: Token[], kind: TokenKind): boolean {
	for (let i = tokens.length - 1; i >= 0; i--) {
		const t = tokens[i];
		if (!t) return false;
		if (t.kind === 'text') continue;
		return t.kind === kind;
	}
	return false;
}

function isSpace(ch: number): boolean {
	return ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d;
}

function isIdentStart(ch: number): boolean {
	return (
		(ch >= 0x41 && ch <= 0x5a) || // A-Z
		(ch >= 0x61 && ch <= 0x7a) || // a-z
		ch === 0x5f /* _ */
	);
}

function isIdentBody(ch: number): boolean {
	return (
		isIdentStart(ch) ||
		(ch >= 0x30 && ch <= 0x39) || // 0-9
		ch === 0x2d /* - */ ||
		ch === 0x2e /* . */
	);
}

function consumeString(source: string, start: number, shortcodeStart: number): Token {
	const quote = source.charCodeAt(start);
	let pos = start + 1;
	const len = source.length;

	if (quote === 0x22 /* " */) {
		// Double-quoted: supports `\"` and `\\` escapes.
		let value = '';
		while (pos < len) {
			const ch = source.charCodeAt(pos);
			if (ch === 0x5c /* \ */) {
				if (pos + 1 >= len) {
					throw makeError(source, shortcodeStart, 'Unterminated quoted string in shortcode');
				}
				const next = source.charCodeAt(pos + 1);
				if (next === 0x22) value += '"';
				else if (next === 0x5c) value += '\\';
				else value += '\\' + String.fromCharCode(next);
				pos += 2;
				continue;
			}
			if (ch === 0x22) {
				return { kind: 'string', start, end: pos + 1, value };
			}
			value += String.fromCharCode(ch);
			pos++;
		}
		throw makeError(source, shortcodeStart, 'Unterminated quoted string in shortcode');
	}

	if (quote === 0x27 /* ' */) {
		const idx = source.indexOf("'", pos);
		if (idx === -1) {
			throw makeError(source, shortcodeStart, 'Unterminated quoted string in shortcode');
		}
		return { kind: 'string', start, end: idx + 1, value: source.slice(pos, idx) };
	}

	// Backtick raw string.
	const idx = source.indexOf('`', pos);
	if (idx === -1) {
		throw makeError(source, shortcodeStart, 'Unterminated raw string in shortcode');
	}
	return { kind: 'string', start, end: idx + 1, value: source.slice(pos, idx) };
}

function makeError(source: string, offset: number, message: string): ShortcodeParseError {
	const { line, column } = locate(source, offset);
	return new ShortcodeParseError(message, offset, line, column);
}

export function locate(source: string, offset: number): { line: number; column: number } {
	let line = 1;
	let lastNewline = -1;
	for (let i = 0; i < offset && i < source.length; i++) {
		if (source.charCodeAt(i) === 0x0a) {
			line++;
			lastNewline = i;
		}
	}
	return { line, column: offset - lastNewline };
}
