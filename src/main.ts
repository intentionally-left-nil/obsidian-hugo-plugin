import { Plugin, WorkspaceLeaf } from 'obsidian';
import { HugoImagesView, VIEW_TYPE_HUGO_IMAGES } from './view/images-view';

export default class HugoImagesPlugin extends Plugin {
	async onload() {
		this.registerView(
			VIEW_TYPE_HUGO_IMAGES,
			(leaf) => new HugoImagesView(leaf, this.app),
		);

		this.addRibbonIcon('image', 'Open hugo images panel', () => {
			void this.activateView();
		});

		this.addCommand({
			id: 'open-panel',
			name: 'Open panel',
			callback: () => {
				void this.activateView();
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
}
