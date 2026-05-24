import { describe, it, expect } from 'vitest';
import { tokenize } from '../src/parser/tokenizer';
import { ShortcodeParseError } from '../src/types';

describe('tokenize', () => {
	it('emits a single text token for plain text', () => {
		const tokens = tokenize('hello world');
		expect(tokens).toEqual([
			{ kind: 'text', start: 0, end: 11, value: 'hello world' },
		]);
	});

	it('returns empty array for empty input', () => {
		expect(tokenize('')).toEqual([]);
	});

	it('tokenises a self-closing figure shortcode', () => {
		const src = '{{< figure src="a.png" />}}';
		const tokens = tokenize(src);
		const kinds = tokens.map((t) => t.kind);
		expect(kinds).toEqual([
			'open',
			'ident',
			'ident',
			'equals',
			'string',
			'self-close',
			'close',
		]);
		expect(tokens[2]!.value).toBe('src');
		expect(tokens[4]!.value).toBe('a.png');
	});

	it('tokenises a non-self-closing shortcode', () => {
		const tokens = tokenize('{{< gallery cols="2" >}}');
		expect(tokens.map((t) => t.kind)).toEqual([
			'open',
			'ident',
			'ident',
			'equals',
			'string',
			'close',
		]);
	});

	it('handles % delimiters', () => {
		const tokens = tokenize('{{% figure src="a" %}}');
		expect(tokens[0]!.kind).toBe('open');
		expect(tokens[0]!.delim).toBe('%');
		const lastTok = tokens[tokens.length - 1];
		expect(lastTok!.kind).toBe('close');
		expect(lastTok!.delim).toBe('%');
	});

	it('preserves text around shortcodes', () => {
		const tokens = tokenize('Hello {{< x >}} world');
		expect(tokens[0]).toMatchObject({ kind: 'text', value: 'Hello ' });
		expect(tokens[tokens.length - 1]).toMatchObject({ kind: 'text', value: ' world' });
	});

	it('tokenises closing tag with slash', () => {
		const tokens = tokenize('{{< /gallery >}}');
		expect(tokens.map((t) => t.kind)).toEqual([
			'open',
			'slash',
			'ident',
			'close',
		]);
	});

	it('handles single-quoted strings as raw', () => {
		const tokens = tokenize(`{{< figure src='a "b" c' >}}`);
		const stringTok = tokens.find((t) => t.kind === 'string');
		expect(stringTok!.value).toBe('a "b" c');
	});

	it('handles backtick raw strings', () => {
		const tokens = tokenize('{{< figure src=`multi\nline` >}}');
		const stringTok = tokens.find((t) => t.kind === 'string');
		expect(stringTok!.value).toBe('multi\nline');
	});

	it('handles escaped quotes in double-quoted strings', () => {
		const tokens = tokenize('{{< figure caption="he said \\"hi\\"" >}}');
		const stringTok = tokens.find((t) => t.kind === 'string');
		expect(stringTok!.value).toBe('he said "hi"');
	});

	it('handles escaped backslashes', () => {
		const tokens = tokenize('{{< figure caption="a\\\\b" >}}');
		const stringTok = tokens.find((t) => t.kind === 'string');
		expect(stringTok!.value).toBe('a\\b');
	});

	it('treats {{ not followed by < or % as text', () => {
		const tokens = tokenize('Some {{ Go }} template-like text');
		expect(tokens).toHaveLength(1);
		expect(tokens[0]!.kind).toBe('text');
	});

	it('throws on unterminated double-quoted string', () => {
		expect(() => tokenize('{{< figure src="oops >}}')).toThrow(ShortcodeParseError);
	});

	it('throws on unterminated raw string', () => {
		expect(() => tokenize('{{< figure src=`oops >}}')).toThrow(ShortcodeParseError);
	});

	it('throws on unterminated shortcode', () => {
		expect(() => tokenize('{{< figure src="x" ')).toThrow(ShortcodeParseError);
	});

	it('treats bare values as bare', () => {
		const tokens = tokenize('{{< figure cover=true >}}');
		// `cover` is `ident`; `true` follows `=`. The lexeme classes are both
		// `ident` lexically — distinguishing them is the parser's job.
		const eqIdx = tokens.findIndex((t) => t.kind === 'equals');
		expect(tokens[eqIdx + 1]!.value).toBe('true');
	});

	it('records correct start/end offsets', () => {
		const src = 'a {{< x >}} b';
		const tokens = tokenize(src);
		const open = tokens.find((t) => t.kind === 'open')!;
		expect(src.slice(open.start, open.end)).toBe('{{<');
		const close = tokens.find((t) => t.kind === 'close')!;
		expect(src.slice(close.start, close.end)).toBe('>}}');
	});
});
