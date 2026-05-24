import type { TFile } from 'obsidian';

/**
 * AST types produced by the shortcode parser. The AST is intentionally
 * generic over shortcode names (not specialized to figure/gallery) so it can
 * be reused later for live-preview / reading-mode rendering.
 */

export type Delim = '<' | '%';

export interface ArgValue {
	value: string;
}

export interface ShortcodeArgs {
	named: Map<string, ArgValue>;
	positional: ArgValue[];
}

export interface TextNode {
	kind: 'text';
	start: number;
	end: number;
	value: string;
}

export interface ShortcodeNode {
	kind: 'shortcode';
	name: string;
	delim: Delim;
	args: ShortcodeArgs;
	selfClosing: boolean;
	start: number;        // byte offset of the opening `{{`
	end: number;          // byte offset just after the closing `}}`
	innerStart?: number;  // for paired tags only
	innerEnd?: number;
	children: AstNode[];
}

export type AstNode = TextNode | ShortcodeNode;

export class ShortcodeParseError extends Error {
	offset: number;
	line: number;
	column: number;

	constructor(message: string, offset: number, line: number, column: number) {
		super(`${message} (line ${line}, column ${column})`);
		this.name = 'ShortcodeParseError';
		this.offset = offset;
		this.line = line;
		this.column = column;
	}
}

/**
 * Application-level types describing a parsed Hugo blog post and its images.
 */

export interface CoverFrontmatter {
	src: string;
	alt?: string;
	caption?: string;
}

export type ImageSource =
	| { kind: 'cover' }
	| { kind: 'figure'; nodeIndex: number }
	| { kind: 'figure-cover'; nodeIndexes: number[] }
	| { kind: 'gallery-item'; galleryIndex: number; childIndex: number };

export interface ReferencedImageEntry {
	kind: 'referenced';
	source: ImageSource;
	src: string;
	file: TFile | null;
	alt: string;
	caption: string;
	isCover: boolean;
}

export interface UnreferencedImageEntry {
	kind: 'unreferenced';
	src: string;
	file: TFile;
}

export type ImageEntry = ReferencedImageEntry | UnreferencedImageEntry;

export interface ParsedPost {
	file: TFile;
	body: string;
	bodyStart: number;
	ast: AstNode[];
	cover: CoverFrontmatter | null;
	images: ImageEntry[];
	needsMigration: boolean;
}
