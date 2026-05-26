import {
	ItemView,
	Notice,
	TFile,
	TFolder,
	setIcon,
	requestUrl,
	type App,
	type TAbstractFile,
	type WorkspaceLeaf,
} from 'obsidian';
import {
	type ImageEntry,
	type ParsedPost,
	type ReferencedImageEntry,
	type UnreferencedImageEntry,
	ShortcodeParseError,
} from '../types';
import {
	appendFigureToBody,
	collectCoverMigration,
	findShortcodeForEntry,
	readPost,
	removeShortcodeFromBody,
	setFigureCoverArg,
	setShortcodeArgs,
	splitFrontmatter,
	stripFigureCoverOverrides,
	type PostAdapter,
} from '../parser/post';
import { getImagesFolder, isHugoPost, listImageFiles } from '../utils/paths';
import { renderCard } from './image-card';
import { AddImageModal } from './add-image-modal';
import { addImageFromFile, addImageFromUrl, type AddImageAdapter } from '../utils/add-image';

export const VIEW_TYPE_HUGO_IMAGES = 'hugo-images-view';

export class HugoImagesView extends ItemView {
	private readonly app2: App;
	private postFile: TFile | null = null;
	private parsed: ParsedPost | null = null;
	private parseError: ShortcodeParseError | null = null;
	private adapter: PostAdapter;
	private addAdapter: AddImageAdapter;
	private renderTimer: number | null = null;
	private isWriting = false;

	constructor(leaf: WorkspaceLeaf, app: App) {
		super(leaf);
		this.app2 = app;
		this.adapter = makeObsidianAdapter(app);
		this.addAdapter = makeAddImageAdapter(app);
	}

	getViewType(): string {
		return VIEW_TYPE_HUGO_IMAGES;
	}

	getDisplayText(): string {
		return 'Hugo images';
	}

	getIcon(): string {
		return 'image';
	}

	override async onOpen(): Promise<void> {
		this.registerEvent(this.app2.workspace.on('active-leaf-change', () => this.bindToActiveFile()));
		this.registerEvent(this.app2.workspace.on('file-open', () => this.bindToActiveFile()));
		this.registerEvent(this.app2.vault.on('modify', (file) => this.handleVaultEvent(file)));
		this.registerEvent(this.app2.vault.on('create', (file) => this.handleVaultEvent(file)));
		this.registerEvent(this.app2.vault.on('delete', (file) => this.handleVaultEvent(file)));
		this.registerEvent(this.app2.vault.on('rename', (file, oldPath) => this.handleRename(file, oldPath)));

		await this.bindToActiveFile();
	}

	override async onClose(): Promise<void> {
		if (this.renderTimer !== null) {
			window.clearTimeout(this.renderTimer);
			this.renderTimer = null;
		}
	}

	private async bindToActiveFile(): Promise<void> {
		const active = this.app2.workspace.getActiveFile();
		if (!isHugoPost(active)) {
			this.postFile = null;
			this.parsed = null;
			this.parseError = null;
			this.render();
			return;
		}
		this.postFile = active;
		await this.reload();
	}

	private async reload(): Promise<void> {
		if (!this.postFile) return;
		try {
			this.parsed = await readPost(this.adapter, this.postFile);
			this.parseError = null;
		} catch (err) {
			if (err instanceof ShortcodeParseError) {
				this.parseError = err;
				this.parsed = null;
			} else {
				throw err;
			}
		}

		if (this.parsed && this.parsed.needsMigration) {
			await this.runMigration();
			return; // runMigration will re-load and re-render.
		}

		this.scheduleRender();
	}

	private async runMigration(): Promise<void> {
		if (!this.postFile || !this.parsed) return;
		const migration = collectCoverMigration(this.parsed.ast);
		this.isWriting = true;
		try {
			await this.adapter.processFrontMatter(this.postFile, (fm) => {
				const existing = (fm['cover'] && typeof fm['cover'] === 'object' ? fm['cover'] : {}) as Record<string, unknown>;
				const next: Record<string, unknown> = { ...existing };
				if (migration.src && next['src'] === undefined) next['src'] = migration.src;
				if (migration.alt && next['alt'] === undefined) next['alt'] = migration.alt;
				if (migration.caption && next['caption'] === undefined) next['caption'] = migration.caption;
				if (typeof next['src'] === 'string') {
					fm['cover'] = next;
				}
			});
			await this.adapter.processBody(this.postFile, (raw) => {
				const split = splitFrontmatter(raw);
				const newBody = stripFigureCoverOverrides(split.body);
				return raw.slice(0, split.bodyStart) + newBody;
			});
			new Notice('Migrated cover overrides to frontmatter');
		} finally {
			this.isWriting = false;
		}
		await this.reload();
	}

	private handleVaultEvent(file: TAbstractFile): void {
		if (!this.postFile) return;
		if (this.isWriting) return;
		if (!this.isRelevantFile(file)) return;
		this.scheduleReload();
	}

	private handleRename(file: TAbstractFile, oldPath: string): void {
		if (!this.postFile) return;
		if (this.postFile.path === oldPath && file instanceof TFile) {
			this.postFile = file;
		}
		if (this.isRelevantFile(file) || this.isPathUnderImagesFolder(oldPath)) {
			this.scheduleReload();
		}
	}

	private isRelevantFile(file: TAbstractFile): boolean {
		if (!this.postFile) return false;
		if (file.path === this.postFile.path) return true;
		return this.isPathUnderImagesFolder(file.path);
	}

	private isPathUnderImagesFolder(path: string): boolean {
		if (!this.postFile) return false;
		const folder = this.postFile.parent?.path ?? '';
		const prefix = folder ? `${folder}/images/` : 'images/';
		return path.startsWith(prefix);
	}

	private scheduleReload(): void {
		if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
		this.renderTimer = window.setTimeout(() => {
			this.renderTimer = null;
			void this.reload();
		}, 100);
	}

	private scheduleRender(): void {
		if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
		this.renderTimer = window.setTimeout(() => {
			this.renderTimer = null;
			this.render();
		}, 50);
	}

	private render(): void {
		if (this.shouldSkipRender()) return;
		const container = this.contentEl;
		container.empty();
		container.addClass('hugo-images-view');

		if (this.parseError) {
			this.renderError(container);
			return;
		}
		if (!this.postFile) {
			container.createDiv({
				cls: 'hugo-images-empty',
				text: 'Open a Hugo blog post (folder/index.md) to manage its images.',
			});
			return;
		}
		if (!this.parsed) {
			container.createDiv({ cls: 'hugo-images-empty', text: 'Loading…' });
			return;
		}

		const folderName = this.postFile.parent?.name ?? '';
		const header = container.createDiv({ cls: 'hugo-images-header' });
		header.createSpan({ text: folderName ? `${folderName} / index.md` : 'index.md' });
		const addBtn = header.createEl('button', { cls: 'hugo-images-add-btn', attr: { 'aria-label': 'Add image' } });
		setIcon(addBtn, 'plus');
		addBtn.addEventListener('click', () => this.handleAddImage());

		if (this.parsed.images.length === 0) {
			container.createDiv({
				cls: 'hugo-images-empty',
				text: 'No images found. Add files to the images/ folder.',
			});
			return;
		}

		const callbacks = this.makeCallbacks();
		let lastKind: ImageEntry['kind'] | null = null;
		for (const entry of this.parsed.images) {
			if (entry.kind === 'unreferenced' && lastKind !== 'unreferenced') {
				container.createDiv({
					cls: 'hugo-images-section-header',
					text: 'Unreferenced',
				});
			}
			renderCard(container, this.app2, this.postFile, entry, callbacks);
			lastKind = entry.kind;
		}
	}

	private renderError(container: HTMLElement): void {
		container.createDiv({
			cls: 'hugo-images-header',
			text: this.postFile?.path ?? '',
		});
		const err = this.parseError!;
		container.createDiv({
			cls: 'hugo-images-error',
			text: `Cannot parse this post:\n${err.message}`,
		});
	}

	private shouldSkipRender(): boolean {
		const active = document.activeElement;
		if (!active) return false;
		if (!(active instanceof HTMLInputElement) && !(active instanceof HTMLTextAreaElement)) return false;
		return this.contentEl.contains(active);
	}

	private makeCallbacks() {
		return {
			onAltChanged: (entry: ReferencedImageEntry, value: string) => {
				void this.handleAltOrCaptionChange(entry, 'alt', value);
			},
			onCaptionChanged: (entry: ReferencedImageEntry, value: string) => {
				void this.handleAltOrCaptionChange(entry, 'caption', value);
			},
			onCoverChanged: (entry: ReferencedImageEntry, isCover: boolean) => {
				void this.handleCoverChange(entry, isCover);
			},
			onInsert: (entry: UnreferencedImageEntry) => {
				void this.handleInsert(entry);
			},
			onDelete: (entry: ImageEntry) => {
				void this.handleDelete(entry);
			},
		};
	}

	private async handleAltOrCaptionChange(
		entry: ReferencedImageEntry,
		field: 'alt' | 'caption',
		value: string,
	): Promise<void> {
		if (!this.postFile || !this.parsed) return;
		// Cover (frontmatter or figure-cover) edits go to frontmatter.
		if (entry.source.kind === 'cover' || entry.source.kind === 'figure-cover') {
			await this.runWrite(async () => {
				await this.adapter.processFrontMatter(this.postFile!, (fm) => {
					const existing = (fm['cover'] && typeof fm['cover'] === 'object' ? fm['cover'] : {}) as Record<string, unknown>;
					const next: Record<string, unknown> = { ...existing };
					if (value === '') delete next[field];
					else next[field] = value;
					fm['cover'] = next;
				});
			});
			return;
		}

		const node = findShortcodeForEntry(this.parsed.ast, entry);
		if (!node) return;
		await this.runWrite(async () => {
			await this.adapter.processBody(this.postFile!, (raw) => {
				const split = splitFrontmatter(raw);
				try {
					const newBody = setShortcodeArgs(split.body, node, { [field]: value });
					return raw.slice(0, split.bodyStart) + newBody;
				} catch {
					new Notice('Edit failed — file unchanged');
					return raw;
				}
			});
		});
	}

	private async handleCoverChange(
		entry: ReferencedImageEntry,
		isCover: boolean,
	): Promise<void> {
		if (!this.postFile) return;
		if (!isCover && entry.isCover) {
			// Unchecking the current cover — clear frontmatter cover.
			await this.runWrite(async () => {
				await this.adapter.processFrontMatter(this.postFile!, (fm) => {
					delete fm['cover'];
				});
				// If the cover had a figure shortcode, remove cover=true from it.
				if (entry.source.kind === 'figure-cover') {
					for (const nodeIndex of entry.source.nodeIndexes) {
						await this.adapter.processBody(this.postFile!, (raw) => {
							const split = splitFrontmatter(raw);
							const newBody = setFigureCoverArg(split.body, nodeIndex, false);
							return raw.slice(0, split.bodyStart) + newBody;
						});
					}
				}
			});
			return;
		}
		if (isCover && !entry.isCover) {
			// Promote this entry to cover. Copy its src/alt/caption to frontmatter.
			await this.runWrite(async () => {
				await this.adapter.processFrontMatter(this.postFile!, (fm) => {
					const next: Record<string, unknown> = { src: entry.src };
					if (entry.alt) next['alt'] = entry.alt;
					if (entry.caption) next['caption'] = entry.caption;
					fm['cover'] = next;
				});
				// If the entry is a figure shortcode, add cover=true to it.
				if (entry.source.kind === 'figure') {
					const nodeIndex = entry.source.nodeIndex;
					await this.adapter.processBody(this.postFile!, (raw) => {
						const split = splitFrontmatter(raw);
						const newBody = setFigureCoverArg(split.body, nodeIndex, true);
						return raw.slice(0, split.bodyStart) + newBody;
					});
				}
			});
			return;
		}
		// No-op: checking a cover that's already the cover, or unchecking a non-cover.
	}

	private async handleDelete(entry: ImageEntry): Promise<void> {
		if (!this.postFile || !this.parsed) return;

		await this.runWrite(async () => {
			// 1. Remove the shortcode from the body (no-op for cover-only entries).
			if (entry.kind === 'referenced') {
				await this.adapter.processBody(this.postFile!, (raw) => {
					const split = splitFrontmatter(raw);
					const newBody = removeShortcodeFromBody(split.body, entry);
					return raw.slice(0, split.bodyStart) + newBody;
				});

				// 2. If this was the cover, clear the frontmatter cover key too.
				if (entry.isCover) {
					await this.adapter.processFrontMatter(this.postFile!, (fm) => {
						delete fm['cover'];
					});
				}
			}

			// 3. Delete the physical file from the vault (only for files inside
			//    the post bundle — external URLs and missing files are skipped).
			const file = entry.kind === 'referenced' ? entry.file : entry.file;
			if (file) {
				await this.app2.vault.trash(file, true);
			}
		});
	}

	private async handleInsert(entry: UnreferencedImageEntry): Promise<void> {
		if (!this.postFile) return;
		await this.runWrite(async () => {
			await this.adapter.processBody(this.postFile!, (raw) => {
				const split = splitFrontmatter(raw);
				try {
					const newBody = appendFigureToBody(split.body, entry.src);
					return raw.slice(0, split.bodyStart) + newBody;
				} catch {
					new Notice('Edit failed — file unchanged');
					return raw;
				}
			});
		});
	}

	private handleAddImage(): void {
		if (!this.postFile) return;
		const post = this.postFile;
		new AddImageModal(this.app2, (choice) => {
			void this.runWrite(async () => {
				let newFile: TFile;
				if (choice.kind === 'file') {
					newFile = await addImageFromFile(this.addAdapter, post, choice.file);
				} else {
					newFile = await addImageFromUrl(this.addAdapter, post, choice.url, choice.filename || undefined);
				}

				// Derive the src path relative to the post folder (same as deriveSrcFromFile).
				const folder = post.parent?.path ?? '';
				const src = folder && newFile.path.startsWith(`${folder}/`)
					? newFile.path.slice(folder.length + 1)
					: newFile.path;

				// Append a figure shortcode to the body.
				await this.adapter.processBody(post, (raw) => {
					const split = splitFrontmatter(raw);
					const newBody = appendFigureToBody(split.body, src);
					return raw.slice(0, split.bodyStart) + newBody;
				});

				new Notice(`Added ${newFile.name}`);
			});
		}).open();
	}

	private async runWrite(fn: () => Promise<void>): Promise<void> {
		console.log(`[hugo-images] runWrite() start, isWriting=${this.isWriting}`);
		this.isWriting = true;
		try {
			await fn();
			console.log(`[hugo-images] runWrite() fn() completed successfully`);
		} catch (err) {
			console.error('Hugo images write failed', err);
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`Hugo images: ${msg}`);
		} finally {
			this.isWriting = false;
			console.log(`[hugo-images] runWrite() calling reload()`);
			await this.reload();
		}
	}
}

/**
 * Build a `PostAdapter` that delegates to the Obsidian `App` instance.
 */
export function makeObsidianAdapter(app: App): PostAdapter {
	return {
		readBody: async (file) => app.vault.read(file),
		getFrontmatter: (file) => {
			const cache = app.metadataCache.getFileCache(file);
			return cache?.frontmatter as Record<string, unknown> | undefined;
		},
		listImageFiles: (post) => {
			const folder = getImagesFolder(post);
			if (!folder) return [];
			return listImageFiles(folder);
		},
		resolveImageFile: (post, src) => {
			const folder = post.parent?.path ?? '';
			const cleaned = src.replace(/^\.\//, '');
			let target: string;
			if (cleaned.startsWith('/')) {
				target = cleaned.slice(1);
			} else if (folder) {
				target = `${folder}/${cleaned}`;
			} else {
				target = cleaned;
			}
			return app.vault.getFileByPath(target);
		},
		processFrontMatter: (file, fn) => app.fileManager.processFrontMatter(file, fn),
		processBody: async (file, fn) => {
			await app.vault.process(file, fn);
		},
	};
}

/**
 * Build an `AddImageAdapter` that delegates to the Obsidian `App` instance.
 */
export function makeAddImageAdapter(app: App): AddImageAdapter {
	return {
		ensureImagesFolder: async (post: TFile): Promise<string> => {
			const parent = post.parent;
			if (!parent) throw new Error('Post has no parent folder');
			const folderPath = `${parent.path}/images`;
			const existing = app.vault.getAbstractFileByPath(folderPath);
			if (existing instanceof TFolder) return folderPath;
			await app.vault.createFolder(folderPath);
			return folderPath;
		},
		fileExists: (path: string): boolean => {
			return app.vault.getAbstractFileByPath(path) !== null;
		},
		createBinary: async (path: string, data: ArrayBuffer): Promise<TFile> => {
			return app.vault.createBinary(path, data);
		},
		requestUrl: async (opts: { url: string }) => {
			const response = await requestUrl({ url: opts.url, method: 'GET' });
			return {
				status: response.status,
				arrayBuffer: response.arrayBuffer,
				headers: response.headers as Record<string, string>,
			};
		},
	};
}
