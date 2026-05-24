/**
 * Minimal mock of the `obsidian` module for unit tests. We only mock the
 * runtime constructors we use (TFile, TFolder). Type-only imports continue to
 * resolve via the bundled obsidian.d.ts during typecheck.
 */
export class TAbstractFile {
	path: string = '';
	name: string = '';
	parent: TFolder | null = null;
}

export class TFile extends TAbstractFile {
	extension: string = '';
	stat: { ctime: number; mtime: number; size: number } = { ctime: 0, mtime: 0, size: 0 };
	basename: string = '';
}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
	isRoot(): boolean {
		return this.parent === null;
	}
}
