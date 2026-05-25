import { App, MarkdownPostProcessorContext, Plugin, TFile, editorInfoField, editorLivePreviewField } from 'obsidian';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { parse, findShortcodes } from '../parser/shortcodes';
import type { ShortcodeNode } from '../types';

// Fast-path guard: only invoke the parser when a figure shortcode is plausibly present.
const FIGURE_RE = /\{\{<\s*figure[\s/>]/;

interface FigureAttrs {
	src: string;
	alt: string;
	caption: string;
}

/**
 * Read the cover frontmatter for the file at `sourcePath`, if any.
 * Returns null when no `cover.src` is present.
 */
function getCoverFrontmatter(app: App, sourcePath: string): { src: string; alt: string; caption: string } | null {
	const file = app.vault.getFileByPath(sourcePath);
	if (!file) return null;
	const fm = app.metadataCache.getFileCache(file)?.frontmatter;
	if (!fm) return null;
	const cover = fm['cover'];
	if (!cover || typeof cover !== 'object') return null;
	const c = cover as Record<string, unknown>;
	if (typeof c['src'] !== 'string' || !c['src']) return null;
	return {
		src: c['src'] as string,
		alt: typeof c['alt'] === 'string' ? c['alt'] : '',
		caption: typeof c['caption'] === 'string' ? c['caption'] : '',
	};
}

function attrsFromNode(node: ShortcodeNode, app: App, sourcePath: string): FigureAttrs {
	const isCover = node.args.named.get('cover')?.value === 'true';

	// For cover figures, src/alt/caption come from frontmatter, not the shortcode args.
	if (isCover) {
		const cover = getCoverFrontmatter(app, sourcePath);
		if (cover) {
			return { src: cover.src, alt: cover.alt, caption: cover.caption };
		}
		// Fallback: cover frontmatter missing, try inline args (pre-migration state).
	}

	return {
		src: node.args.named.get('src')?.value ?? node.args.positional[0]?.value ?? '',
		alt: node.args.named.get('alt')?.value ?? '',
		caption: node.args.named.get('caption')?.value ?? '',
	};
}

function resolveImageSrc(app: App, src: string, sourcePath: string): string {
	const dir = sourcePath.substring(0, sourcePath.lastIndexOf('/'));
	const relativePath = dir ? `${dir}/${src}` : src;
	const file = app.vault.getFileByPath(relativePath);
	if (file instanceof TFile) return app.vault.getResourcePath(file);
	return src;
}

function buildFigureElement(app: App, attrs: FigureAttrs, sourcePath: string): HTMLElement {
	const figure = document.createElement('figure');
	figure.className = 'hugo-figure';

	const img = document.createElement('img');
	img.className = 'hugo-figure-img';
	img.src = resolveImageSrc(app, attrs.src, sourcePath);
	img.alt = attrs.alt;
	figure.appendChild(img);

	if (attrs.caption) {
		const cap = document.createElement('figcaption');
		cap.className = 'hugo-figure-caption';
		cap.textContent = attrs.caption;
		figure.appendChild(cap);
	}

	return figure;
}

/* ---------------------------------------------------------------------------
 * CodeMirror widget — live preview mode
 * ------------------------------------------------------------------------- */

class FigureWidget extends WidgetType {
	constructor(
		private readonly attrs: FigureAttrs,
		private readonly resolvedSrc: string,
	) {
		super();
	}

	toDOM(): HTMLElement {
		const figure = document.createElement('figure');
		figure.className = 'hugo-figure';

		const img = document.createElement('img');
		img.className = 'hugo-figure-img';
		img.src = this.resolvedSrc;
		img.alt = this.attrs.alt;
		figure.appendChild(img);

		if (this.attrs.caption) {
			const cap = document.createElement('figcaption');
			cap.className = 'hugo-figure-caption';
			cap.textContent = this.attrs.caption;
			figure.appendChild(cap);
		}

		return figure;
	}

	eq(other: FigureWidget): boolean {
		return (
			other.resolvedSrc === this.resolvedSrc &&
			other.attrs.alt === this.attrs.alt &&
			other.attrs.caption === this.attrs.caption
		);
	}
}

function buildDecorations(view: EditorView, app: App): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();

	// Only decorate in live preview, not source mode.
	if (!view.state.field(editorLivePreviewField, false)) return builder.finish();

	const cursor = view.state.selection.main.head;
	const sourcePath = view.state.field(editorInfoField, false)?.file?.path ?? '';

	for (const { from, to } of view.visibleRanges) {
		const text = view.state.doc.sliceString(from, to);
		if (!FIGURE_RE.test(text)) continue;

		let ast;
		try {
			ast = parse(text);
		} catch {
			continue;
		}

		for (const node of findShortcodes(ast, 'figure')) {
			const start = from + node.start;
			const end = from + node.end;
			const line = view.state.doc.lineAt(start);

			// Show raw shortcode when the cursor is on this line so it's editable.
			if (view.hasFocus && cursor >= line.from && cursor <= line.to) continue;

			const attrs = attrsFromNode(node, app, sourcePath);
			const resolvedSrc = resolveImageSrc(app, attrs.src, sourcePath);
			builder.add(start, end, Decoration.replace({ widget: new FigureWidget(attrs, resolvedSrc) }));
		}
	}

	return builder.finish();
}

export function createFigureEditorExtension(app: App) {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = buildDecorations(view, app);
			}
			update(update: ViewUpdate) {
				if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged) {
					this.decorations = buildDecorations(update.view, app);
				}
			}
		},
		{ decorations: (v) => v.decorations },
	);
}

/* ---------------------------------------------------------------------------
 * Markdown post-processor — reading view
 * ------------------------------------------------------------------------- */

export function registerFigurePostProcessor(app: App, plugin: Plugin): void {
	plugin.registerMarkdownPostProcessor((element: HTMLElement, context: MarkdownPostProcessorContext) => {
		const { sourcePath } = context;
		element.querySelectorAll('p').forEach((p) => {
			const text = p.textContent ?? '';
			if (!FIGURE_RE.test(text)) return;

			let ast;
			try {
				ast = parse(text);
			} catch {
				return;
			}

			const figures = findShortcodes(ast, 'figure');
			if (figures.length === 0) return;

			// Replace the paragraph with one <figure> element per shortcode found.
			const fragment = document.createDocumentFragment();
			for (const node of figures) {
				fragment.appendChild(buildFigureElement(app, attrsFromNode(node, app, sourcePath), sourcePath));
			}
			p.replaceWith(fragment);
		});
	});
}
