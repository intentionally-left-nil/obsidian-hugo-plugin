import { describe, it, expect } from 'vitest';
import {
	parse,
	serializeShortcodeOpen,
	serializeShortcodeClose,
	applyEdits,
	editShortcodeArgs,
	findShortcodes,
} from '../src/parser/shortcodes';
import { ShortcodeParseError, type ShortcodeNode } from '../src/types';

function shortcodes(ast: ReturnType<typeof parse>): ShortcodeNode[] {
	return ast.filter((n): n is ShortcodeNode => n.kind === 'shortcode');
}

describe('parse', () => {
	it('parses plain text into a single text node', () => {
		const ast = parse('hello world');
		expect(ast).toHaveLength(1);
		expect(ast[0]!.kind).toBe('text');
	});

	it('parses a self-closing figure', () => {
		const ast = parse('{{< figure src="a.png" alt="cat" />}}');
		const sc = shortcodes(ast);
		expect(sc).toHaveLength(1);
		const fig = sc[0]!;
		expect(fig.name).toBe('figure');
		expect(fig.selfClosing).toBe(true);
		expect(fig.args.named.get('src')!.value).toBe('a.png');
		expect(fig.args.named.get('alt')!.value).toBe('cat');
		expect(fig.children).toEqual([]);
	});

	it('parses a non-self-closing void figure (Hugo paired-by-template, but we treat as void if no closing tag)', () => {
		const ast = parse('{{< figure src="a.png" >}} text after');
		const sc = shortcodes(ast);
		expect(sc).toHaveLength(1);
		expect(sc[0]!.selfClosing).toBe(false);
		expect(sc[0]!.children).toEqual([]);
	});

	it('parses a paired gallery with figure children', () => {
		const src = `{{< gallery cols="2" >}}
  {{< figure src="a.png" />}}
  {{< figure src="b.png" alt="b" />}}
{{< /gallery >}}`;
		const ast = parse(src);
		const sc = shortcodes(ast);
		expect(sc).toHaveLength(1);
		const gallery = sc[0]!;
		expect(gallery.name).toBe('gallery');
		expect(gallery.selfClosing).toBe(false);
		const childFigures = gallery.children.filter(
			(c): c is ShortcodeNode => c.kind === 'shortcode',
		);
		expect(childFigures).toHaveLength(2);
		expect(childFigures[0]!.args.named.get('src')!.value).toBe('a.png');
		expect(childFigures[1]!.args.named.get('alt')!.value).toBe('b');
	});

	it('parses cover=true bare value', () => {
		const ast = parse('{{< figure cover=true />}}');
		const fig = shortcodes(ast)[0]!;
		expect(fig.args.named.get('cover')!.value).toBe('true');
	});

	it('throws on unclosed paired tag', () => {
		expect(() => parse('{{< gallery >}} no closing tag here')).toThrow(ShortcodeParseError);
	});

	it('throws on mismatched closing tag', () => {
		expect(() => parse('{{< gallery >}} {{< /figure >}}')).toThrow(ShortcodeParseError);
	});

	it('throws on stray closing tag', () => {
		expect(() => parse('{{< /figure >}}')).toThrow(ShortcodeParseError);
	});

	it('records byte offsets that map back to source', () => {
		const src = 'before {{< figure src="x" />}} after';
		const ast = parse(src);
		const fig = shortcodes(ast)[0]!;
		expect(src.slice(fig.start, fig.end)).toBe('{{< figure src="x" />}}');
	});

	it('preserves text nodes verbatim, including whitespace', () => {
		const src = '\n\n{{< figure src="a" />}}\n\n';
		const ast = parse(src);
		const texts = ast.filter((n) => n.kind === 'text');
		expect(texts.map((t) => (t as { value: string }).value).join('')).toBe('\n\n\n\n');
	});

	it('parses nested figure inside gallery and records innerStart/innerEnd', () => {
		const src = '{{< gallery >}}{{< figure src="a" />}}{{< /gallery >}}';
		const ast = parse(src);
		const gallery = shortcodes(ast)[0]!;
		expect(gallery.innerStart).toBeDefined();
		expect(gallery.innerEnd).toBeDefined();
		const inner = src.slice(gallery.innerStart, gallery.innerEnd);
		expect(inner).toBe('{{< figure src="a" />}}');
	});
});

describe('serializeShortcodeOpen', () => {
	it('round-trips a self-closing figure with double quotes', () => {
		const src = '{{< figure src="a.png" alt="cat" />}}';
		const fig = shortcodes(parse(src))[0]!;
		expect(serializeShortcodeOpen(fig)).toBe('{{< figure src="a.png" alt="cat" /' + '>}}');
	});

	it('preserves bare bool values', () => {
		const fig = shortcodes(parse('{{< figure cover=true />}}'))[0]!;
		expect(serializeShortcodeOpen(fig)).toContain('cover=true');
		expect(serializeShortcodeOpen(fig)).not.toContain('cover="true"');
	});

	it('drops empty named args', () => {
		const fig = shortcodes(parse('{{< figure src="a" />}}'))[0]!;
		fig.args.named.set('alt', { value: '' });
		const out = serializeShortcodeOpen(fig);
		expect(out).not.toContain('alt');
	});

	it('escapes internal double quotes', () => {
		const fig = shortcodes(parse('{{< figure src="a" />}}'))[0]!;
		fig.args.named.set('caption', { value: 'he said "hi"' });
		const out = serializeShortcodeOpen(fig);
		expect(out).toContain('caption="he said \\"hi\\""');
	});

	it('escapes internal backslashes', () => {
		const fig = shortcodes(parse('{{< figure src="a" />}}'))[0]!;
		fig.args.named.set('caption', { value: 'a\\b' });
		const out = serializeShortcodeOpen(fig);
		expect(out).toContain('caption="a\\\\b"');
	});

	it('serialises non-self-closing open tag without trailing /', () => {
		const node = shortcodes(parse('{{< gallery cols="2" >}}{{< /gallery >}}'))[0]!;
		const out = serializeShortcodeOpen(node);
		expect(out).toBe('{{< gallery cols="2" >}}');
	});

	it('serialises % delimiters', () => {
		const fig = shortcodes(parse('{{% figure src="a" %}}'))[0]!;
		const out = serializeShortcodeOpen(fig);
		expect(out.startsWith('{{%')).toBe(true);
		expect(out.endsWith('%}}')).toBe(true);
	});
});

describe('serializeShortcodeClose', () => {
	it('returns empty for self-closing', () => {
		const fig = shortcodes(parse('{{< figure src="a" />}}'))[0]!;
		expect(serializeShortcodeClose(fig)).toBe('');
	});

	it('returns matching closing tag for paired', () => {
		const node = shortcodes(parse('{{< gallery >}}{{< /gallery >}}'))[0]!;
		expect(serializeShortcodeClose(node)).toBe('{{< /gallery >}}');
	});
});

describe('applyEdits', () => {
	it('applies a single edit', () => {
		const out = applyEdits('hello world', [
			{ start: 6, end: 11, replacement: 'there' },
		]);
		expect(out).toBe('hello there');
	});

	it('applies multiple non-overlapping edits right-to-left', () => {
		const out = applyEdits('aaa bbb ccc', [
			{ start: 0, end: 3, replacement: 'XXX' },
			{ start: 8, end: 11, replacement: 'ZZZ' },
		]);
		expect(out).toBe('XXX bbb ZZZ');
	});

	it('throws on overlapping edits', () => {
		expect(() =>
			applyEdits('abcdef', [
				{ start: 0, end: 3, replacement: 'X' },
				{ start: 2, end: 5, replacement: 'Y' },
			]),
		).toThrow(/overlapping/i);
	});

	it('handles inserts (zero-width edits)', () => {
		const out = applyEdits('hello', [{ start: 5, end: 5, replacement: '!' }]);
		expect(out).toBe('hello!');
	});
});

describe('findShortcodes', () => {
	it('returns top-level matches', () => {
		const src = '{{< figure src="a" />}} text {{< figure src="b" />}}';
		const figs = findShortcodes(parse(src), 'figure');
		expect(figs).toHaveLength(2);
	});

	it('returns nested matches inside galleries', () => {
		const src = '{{< gallery >}}{{< figure src="a" />}}{{< figure src="b" />}}{{< /gallery >}}';
		const figs = findShortcodes(parse(src), 'figure');
		expect(figs).toHaveLength(2);
	});
});

describe('editShortcodeArgs', () => {
	it('rewrites a self-closing figure with new alt', () => {
		const src = 'before {{< figure src="a.png" alt="old" />}} after';
		const ast = parse(src);
		const fig = shortcodes(ast)[0]!;
		const edit = editShortcodeArgs(src, fig, (args) => {
			args.named.set('alt', { value: 'new' });
		});
		const out = applyEdits(src, [edit]);
		expect(out).toBe('before {{< figure src="a.png" alt="new" />}} after');
	});

	it('only rewrites the open tag of a paired shortcode', () => {
		const src = '{{< gallery cols="2" >}}{{< figure src="a" />}}{{< /gallery >}}';
		const ast = parse(src);
		const gallery = shortcodes(ast)[0]!;
		const edit = editShortcodeArgs(src, gallery, (args) => {
			args.named.set('cols', { value: '3' });
		});
		const out = applyEdits(src, [edit]);
		expect(out).toBe('{{< gallery cols="3" >}}{{< figure src="a" />}}{{< /gallery >}}');
	});

	it('removes an arg by setting it to empty string', () => {
		const src = '{{< figure src="a" alt="x" caption="c" />}}';
		const fig = shortcodes(parse(src))[0]!;
		const edit = editShortcodeArgs(src, fig, (args) => {
			args.named.set('alt', { value: '' });
			args.named.set('caption', { value: '' });
		});
		const out = applyEdits(src, [edit]);
		expect(out).toBe('{{< figure src="a" />}}');
	});
});
