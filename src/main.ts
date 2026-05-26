import { Plugin, WorkspaceLeaf } from 'obsidian';
import { HugoImagesView, VIEW_TYPE_HUGO_IMAGES } from './view/images-view';
import { HugoBlogsView, VIEW_TYPE_HUGO_BLOGS } from './view/blogs-view';
import { registerFigurePostProcessor, createFigureEditorExtension } from './view/figure-renderer';

export default class HugoImagesPlugin extends Plugin {
	async onload() {
		this.registerView(
			VIEW_TYPE_HUGO_IMAGES,
			(leaf) => new HugoImagesView(leaf, this.app),
		);

		this.registerView(
			VIEW_TYPE_HUGO_BLOGS,
			(leaf) => new HugoBlogsView(leaf, this.app),
		);

		this.registerEditorExtension(createFigureEditorExtension(this.app));
		registerFigurePostProcessor(this.app, this);

		this.addRibbonIcon('image', 'Open hugo images panel', () => {
			void this.activateView();
		});

		this.addRibbonIcon('newspaper', 'Open hugo blogs', () => {
			void this.activateBlogsView();
		});

		this.addCommand({
			id: 'open-panel',
			name: 'Open panel',
			callback: () => {
				void this.activateView();
			},
		});

		this.addCommand({
			id: 'open-blogs-panel',
			name: 'Open blogs panel',
			callback: () => {
				void this.activateBlogsView();
			},
		});
	}

	onunload() {
		// Leaves of our view type are detached automatically by Obsidian.
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;

		const existing = workspace.getLeavesOfType(VIEW_TYPE_HUGO_IMAGES);
		const first = existing[0];
		if (first) {
			await workspace.revealLeaf(first);
			return;
		}

		const leaf: WorkspaceLeaf | null | undefined = workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({
			type: VIEW_TYPE_HUGO_IMAGES,
			active: true,
		});
		await workspace.revealLeaf(leaf);
	}

	async activateBlogsView(): Promise<void> {
		const { workspace } = this.app;

		const existing = workspace.getLeavesOfType(VIEW_TYPE_HUGO_BLOGS);
		const first = existing[0];
		if (first) {
			await workspace.revealLeaf(first);
			return;
		}

		const leaf = workspace.getLeaf('tab');
		await leaf.setViewState({
			type: VIEW_TYPE_HUGO_BLOGS,
			active: true,
		});
		await workspace.revealLeaf(leaf);
	}
}
