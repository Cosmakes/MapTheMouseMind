// ──────────────────────────────────────────────────────────────────────────────
// MapTheMindView.ts  —  The MapTheMind hierarchical brain-map pane.
//
// Layout (two-panel, consistent across all levels)
// ─────────────────────────────────────────────────
//   .neuro-map-body
//     .neuro-note-navigator  (200 px left)  — vault notes at current level
//     .neuro-canvas-panel    (flex-fill)    — 3D brain (L0) or Allen slice (L1+)
//
// Navigation model
// ────────────────
//   stack[0] = { name: "Mouse Brain" }                   ← Level 0: 3D whole brain
//   stack[1] = { name: "CA1", allenId: 382, … }          ← Level 1: viewpoint / cell
// ──────────────────────────────────────────────────────────────────────────────

import { ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import type NeuroMindmapPlugin from "./main";
import {
	BrainRegionFrontmatter,
	CellTypeFrontmatter,
	ConnectionFrontmatter,
	ConnectionDirection,
	CellClass,
	TopicScope,
	ViewpointFrontmatter,
} from "./types";
import {
	getAncestors,
	getDescendantIds,
	AllenStructureFlat,
} from "./api/allenStructureCache";
import { CreateBrainRegionNoteModal } from "./CreateBrainRegionNoteModal";
import { AddCellModal } from "./AddCellModal";
import { CreateTopicModal } from "./CreateTopicModal";
import { CreateViewpointModal } from "./CreateViewpointModal";
import { BrainViewer3D } from "./views/BrainViewer3D";
import { AllenSectionViewer, ActiveCellNote, ActiveConnection } from "./views/AllenSectionViewer";
import { ViewpointPickerView } from "./views/ViewpointPickerView";
import { ViewpointView } from "./views/ViewpointView";
import { CellView } from "./views/CellView";
import { SearchBar } from "./views/SearchBar";
import { mouseRoot } from "./paths";
import { buildViewpointFromSection, discoverViewpoints } from "./viewpoints";
import { SearchService, type SearchHit, type SearchScope, type SearchResults } from "./search";
import type { AllenAtlasSection } from "./api/allenAtlas2D";

/**
 * Views that participate in the cross-view search overlay system implement
 * this. Direct hits are always rendered by MapTheMindView in a shared
 * side panel; deeper hits are routed to the active view so they can be
 * placed spatially (3D markers, in-view dots, …).
 */
export interface SearchableView {
	applyDeeperHits(term: string, hits: SearchHit[]): void;
	clearDeeperHits(): void;
}

export const VIEW_TYPE_NEURO_MAP = "neuro-hippocampus-map";

// ── Navigation stack ──────────────────────────────────────────────────────────

interface NavEntry {
	name: string;
	allenId?: number;
	selectedRegionId?: string;
	/**
	 * Sub-stage within a depth ≥ 1 entry:
	 *   "picker"       — list of saved viewpoints + create-new
	 *   "slice-picker" — AllenSectionViewer with "Use this slice"
	 *   "viewpoint"    — rendered viewpoint SVG (uses viewpointFile)
	 *   "cell"         — single-cell morphology view (uses cellFile)
	 */
	stage?: "picker" | "slice-picker" | "viewpoint" | "cell";
	viewpointFile?: TFile;
	cellFile?:      TFile;
	/** Slice-picker stage only — chosen by the user, drives the section list
	 *  and is recorded into the viewpoint frontmatter on save. */
	pickerPlane?: "coronal" | "sagittal";
}

// ── Vault query helpers ────────────────────────────────────────────────────────

/**
 * Returns Map<allenId, {color, name}> for all brain-region notes that have an
 * `allen_id` in their frontmatter.  Color is taken from the structure tree.
 */
function getRegionNoteAllenIds(
	app:  import("obsidian").App,
	tree: Map<number, AllenStructureFlat>,
): Map<number, { color: string; name: string }> {
	const result = new Map<number, { color: string; name: string }>();
	for (const file of app.vault.getMarkdownFiles()) {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter as
			Partial<BrainRegionFrontmatter> | undefined;
		if (fm?.entity_type !== "brain-region" || !fm.allen_id) continue;
		const node  = tree.get(fm.allen_id);
		const color = node?.color_hex_triplet ?? "4472c4";
		const name  = fm.region_name ?? node?.name ?? `Structure ${fm.allen_id}`;
		result.set(fm.allen_id, { color, name });
	}
	return result;
}

/** Returns all brain-region notes with their allen_id and name. */
function getAllRegionNotesWithAllen(
	app: import("obsidian").App,
): { file: TFile; allenId: number; name: string; ancestorIds: number[] }[] {
	const results = [];
	for (const file of app.vault.getMarkdownFiles()) {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter as
			Partial<BrainRegionFrontmatter> | undefined;
		if (fm?.entity_type !== "brain-region" || !fm.allen_id) continue;
		results.push({
			file,
			allenId:     fm.allen_id,
			name:        fm.region_name ?? file.basename,
			ancestorIds: fm.allen_ancestor_ids ?? [],
		});
	}
	return results;
}

/** Returns cell-type notes for a given Allen structure (matched by acronym or numeric id). */
function getActiveCellNotes(
	app:     import("obsidian").App,
	allenId: number,
	tree:    Map<number, AllenStructureFlat>,
): ActiveCellNote[] {
	const node    = tree.get(allenId);
	const acronym = node?.acronym.toLowerCase() ?? "";
	const idStr   = allenId.toString();
	const results: ActiveCellNote[] = [];

	for (const file of app.vault.getMarkdownFiles()) {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter as
			Partial<CellTypeFrontmatter> | undefined;
		if (!fm || fm.entity_type !== "cell-type") continue;
		if (!fm.layer_id) continue;
		const region = (fm.brain_region ?? "").toLowerCase();
		if (region !== acronym && region !== idStr) continue;
		results.push({
			layerId:   fm.layer_id,
			cellClass: (fm.cell_class ?? "other") as CellClass,
			file,
		});
	}
	return results;
}

/** Returns all notes (any entity_type) associated with a given Allen structure. */
function getAllNotesForAllenId(
	app:     import("obsidian").App,
	allenId: number,
	tree:    Map<number, AllenStructureFlat>,
): TFile[] {
	const node    = tree.get(allenId);
	const acronym = node?.acronym.toLowerCase() ?? "";
	const idStr   = allenId.toString();
	const results: TFile[] = [];

	for (const file of app.vault.getMarkdownFiles()) {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm) continue;
		if (fm.entity_type === "brain-region" && fm.allen_id === allenId) {
			results.push(file); continue;
		}
		if (fm.entity_type === "cell-type") {
			const r = (fm.brain_region ?? "").toLowerCase();
			if (r === acronym || r === idStr) { results.push(file); continue; }
		}
		if (fm.entity_type === "connection") {
			if (fm.source === idStr || fm.target === idStr ||
				fm.source === acronym || fm.target === acronym) {
				results.push(file); continue;
			}
		}
	}
	return results;
}

/** Returns connection data for the Allen section viewer. */
function getActiveConnections(
	app:     import("obsidian").App,
	allenId: number,
	tree:    Map<number, AllenStructureFlat>,
): ActiveConnection[] {
	const node    = tree.get(allenId);
	const acronym = node?.acronym.toLowerCase() ?? "";
	const idStr   = allenId.toString();
	const connections: ActiveConnection[] = [];
	const cellFiles = new Map<string, string>(); // path → layer_id

	for (const file of app.vault.getMarkdownFiles()) {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter as
			Partial<CellTypeFrontmatter> | undefined;
		if (fm?.entity_type !== "cell-type" || !fm.layer_id) continue;
		const region = (fm.brain_region ?? "").toLowerCase();
		if (region === acronym || region === idStr) {
			cellFiles.set(file.path, fm.layer_id);
		}
	}

	for (const file of app.vault.getMarkdownFiles()) {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter as
			Partial<ConnectionFrontmatter> | undefined;
		if (fm?.entity_type !== "connection" || !fm.source || !fm.target) continue;
		connections.push({
			sourceLayerId: fm.source,
			targetLayerId: fm.target,
			label:         fm.label,
			style:         "explicit",
			direction:     (fm.direction ?? "efferent") as ConnectionDirection,
		});
	}

	const resolvedLinks = app.metadataCache.resolvedLinks;
	for (const srcPath of Object.keys(resolvedLinks)) {
		const srcLayerId = cellFiles.get(srcPath);
		if (!srcLayerId) continue;
		const targets = resolvedLinks[srcPath];
		if (!targets) continue;
		for (const tgtPath of Object.keys(targets)) {
			const tgtLayerId = cellFiles.get(tgtPath);
			if (!tgtLayerId || tgtLayerId === srcLayerId) continue;
			connections.push({
				sourceLayerId: srcLayerId,
				targetLayerId: tgtLayerId,
				style:         "wikilink",
				direction:     "efferent",
			});
		}
	}

	return connections;
}

// ── View ───────────────────────────────────────────────────────────────────────

export class MapTheMindView extends ItemView {
	private plugin:       NeuroMindmapPlugin;
	private navStack:     NavEntry[] = [];
	private viewer3D:     BrainViewer3D | null = null;
	private cellView:     CellView      | null = null;
	private viewpointView: ViewpointView | null = null;
	private navigatorEl:  HTMLElement   | null = null;
	private structureTree: Map<number, AllenStructureFlat> = new Map();
	private searchService: SearchService | null = null;
	private searchBar:     SearchBar     | null = null;
	private searchResultsEl: HTMLElement | null = null;
	private activeSearchable: SearchableView | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: NeuroMindmapPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string    { return VIEW_TYPE_NEURO_MAP; }
	getDisplayText(): string { return "MapTheMind"; }
	getIcon(): string        { return "brain"; }

	async onOpen(): Promise<void> {
		await this.ensureStructureTree();

		this.registerEvent(
			this.app.metadataCache.on("resolved", () => {
				const entry = this.navStack[this.navStack.length - 1];
				if (!entry) return;

				if (this.navStack.length === 1 && this.viewer3D) {
					// Level 0: update 3D meshes + navigator in-place.
					const notes = getRegionNoteAllenIds(this.app, this.structureTree);
					void this.viewer3D.updateRegionNotes(notes);
					this.rebuildNavigator();
				} else if (entry.allenId !== undefined) {
					// ViewpointView and CellView own their own metadata listeners
					// and update incrementally. A full canvas re-render here would
					// destroy ephemeral state (rotation slider, pan/zoom, focus,
					// cell-view selection), so we only refresh the picker and
					// slice-picker stages — those genuinely need a fresh listing
					// when notes are added or removed.
					const stage = entry.stage ?? "picker";
					if (stage === "viewpoint" || stage === "cell") {
						this.rebuildNavigator();
						return;
					}
					const canvasPanel = this.contentEl.querySelector(".neuro-canvas-panel") as HTMLElement | null;
					if (canvasPanel) {
						canvasPanel.empty();
						if (stage === "slice-picker") {
							this.renderAllenSectionViewer(canvasPanel, entry.allenId, true);
						} else {
							this.renderViewpointPicker(canvasPanel, entry.allenId);
						}
					}
					this.rebuildNavigator();
				} else {
					this.render();
				}
			}),
		);
		this.render();
	}

	async onClose(): Promise<void> {
		if (this.viewer3D) { this.viewer3D.dispose(); this.viewer3D = null; }
		if (this.searchService) { this.searchService.destroy(); this.searchService = null; }
	}

	private getSearchService(): SearchService {
		if (!this.searchService) this.searchService = new SearchService(this.app);
		return this.searchService;
	}

	// ── Structure tree init ────────────────────────────────────────────────────

	private async ensureStructureTree(): Promise<void> {
		try {
			await this.plugin.ensureStructureTree();
			this.structureTree = this.plugin.structureTree;
			if (this.structureTree.size === 0) return;
			void this.prefetchWholeBrainMesh();
		} catch (err) {
			new Notice("[neuro-mindmap] Could not load Allen Atlas structure tree — check network.");
			console.warn(err);
		}
	}

	private async prefetchWholeBrainMesh(): Promise<void> {
		const provider = this.plugin.provider;
		const adapter  = this.app.vault.adapter;
		const meshDir  = provider.meshCacheDir;
		const rootPath = `${meshDir}/${provider.rootStructureId}.obj`;
		try { await adapter.mkdir(meshDir); } catch { /* exists */ }
		if (!(await adapter.exists(rootPath))) {
			try {
				const obj = await provider.fetchStructureMeshObj(provider.rootStructureId);
				await adapter.write(rootPath, obj);
			} catch { /* non-fatal */ }
		}
	}

	// ── Top-level render dispatcher ───────────────────────────────────────────

	private render(): void {
		if (this.viewer3D) { this.viewer3D.dispose(); this.viewer3D = null; }
		if (this.cellView) { this.cellView.destroy(); this.cellView = null; }
		if (this.searchBar) { this.searchBar.destroy(); this.searchBar = null; }
		this.viewpointView    = null;
		this.activeSearchable = null;
		this.searchResultsEl  = null;

		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("neuro-map-view");

		if (this.navStack.length === 0) {
			this.navStack = [{ name: this.plugin.provider.brainLabel }];
		}

		const currentEntry = this.navStack[this.navStack.length - 1];
		if (!currentEntry) return;

		this.renderToolbar();

		const body        = contentEl.createDiv({ cls: "neuro-map-body" });
		this.navigatorEl  = body.createDiv({ cls: "neuro-note-navigator" });
		const canvasPanel = body.createDiv({ cls: "neuro-canvas-panel" });
		const canvasHost  = canvasPanel.createDiv({ cls: "neuro-canvas-host" });
		this.searchResultsEl = canvasPanel.createDiv({ cls: "neuro-search-results" });
		this.searchResultsEl.addClass("is-empty");

		const depth = this.navStack.length - 1;
		if (depth === 0) {
			this.render3DViewer(canvasHost);
		} else if (currentEntry.allenId !== undefined) {
			// When stage is undefined (default — set by 3D click / navigator),
			// auto-route: skip the picker if a saved viewpoint exists for this
			// region. The user can still reach the picker via the "Viewpoints"
			// button in the viewpoint header.
			if (currentEntry.stage === undefined) {
				const resolved = this.resolveDefaultViewpoint(currentEntry.allenId);
				if (resolved) {
					currentEntry.stage         = "viewpoint";
					currentEntry.viewpointFile = resolved;
					currentEntry.name          = this.viewpointDisplayName(resolved);
				} else {
					currentEntry.stage = "picker";
				}
			}
			const stage = currentEntry.stage;
			if (stage === "cell" && currentEntry.cellFile) {
				this.renderCellView(canvasHost, currentEntry.cellFile);
			} else if (stage === "viewpoint" && currentEntry.viewpointFile) {
				this.recordLastViewpoint(currentEntry.allenId, currentEntry.viewpointFile);
				this.renderViewpoint(canvasHost, currentEntry.viewpointFile);
			} else if (stage === "slice-picker") {
				this.renderAllenSectionViewer(canvasHost, currentEntry.allenId, true);
			} else {
				this.renderViewpointPicker(canvasHost, currentEntry.allenId);
			}
		}

		this.mountSearchBar(canvasPanel);
		this.rebuildNavigator();
	}

	// ── Search wiring ─────────────────────────────────────────────────────────

	private mountSearchBar(canvasPanel: HTMLElement): void {
		this.searchBar = new SearchBar({
			placeholder: "Search notes (title, themes, body)…",
			onSearch:    term => void this.runSearch(term),
		});
		this.searchBar.render(canvasPanel);

		// "+ Create note" lives in the search bar's action slot so every view
		// shares the same footer toolbar.
		const slot = this.searchBar.getActionSlot();
		if (slot) {
			const btn = slot.createEl("button", {
				text: "+ Create note",
				cls:  "neuro-create-note-btn mod-cta",
			});
			btn.addEventListener("click", () => this.openCreateNoteModal());
		}
	}

	/** Opens the unified note-creation modal with provenance derived from the
	 *  current nav-stack scope. */
	private openCreateNoteModal(): void {
		const top = this.navStack[this.navStack.length - 1];
		const folderRoot = mouseRoot(this.plugin);

		let level: "brain" | "viewpoint" | "cell" = "brain";
		let viewpointFile: TFile | undefined;
		let cellFile:      TFile | undefined;
		const prefillScope: TopicScope[] = [];

		if (top?.allenId !== undefined) {
			if (top.stage === "viewpoint" && top.viewpointFile) {
				level         = "viewpoint";
				viewpointFile = top.viewpointFile;
				prefillScope.push({ allen_id: top.allenId });
			} else if (top.stage === "cell" && top.cellFile) {
				const vpFolder = top.cellFile.parent?.parent;
				const vpCandidate = vpFolder?.children.find(
					c => c instanceof TFile && c.extension === "md" && c.basename === vpFolder.name,
				);
				level         = "cell";
				cellFile      = top.cellFile;
				viewpointFile = vpCandidate instanceof TFile ? vpCandidate : undefined;
				prefillScope.push({ cell: top.cellFile.basename });
				const compartment = this.cellView?.getSelectedCompartment();
				if (compartment) prefillScope[0]!.compartment = compartment;
			}
		}

		new CreateTopicModal(this.app, {
			folderRoot,
			structureTree:   this.structureTree,
			rootStructureId: this.plugin.provider.rootStructureId,
			prefillScope,
			level,
			viewpointFile,
			cellFile,
		}).open();
	}

	private currentSearchScope(): SearchScope | null {
		const top = this.navStack[this.navStack.length - 1];
		if (!top) return null;
		if (this.navStack.length === 1 || top.allenId === undefined) {
			return { level: "brain" };
		}
		const stage = top.stage;
		if (stage === "viewpoint" && top.viewpointFile) {
			return {
				level: "viewpoint",
				viewpointId:  top.viewpointFile.parent?.name ?? top.viewpointFile.basename,
				descendantIds: getDescendantIds(top.allenId, this.structureTree),
			};
		}
		if (stage === "cell" && top.cellFile) {
			const vpFolder = top.cellFile.parent?.parent;
			return {
				level: "cell",
				viewpointId: vpFolder?.name,
				cellId:      top.cellFile.basename,
				descendantIds: getDescendantIds(top.allenId, this.structureTree),
			};
		}
		return { level: "brain" };
	}

	private async runSearch(term: string): Promise<void> {
		const scope = this.currentSearchScope();
		if (!scope || !term.trim()) {
			this.renderSearchResults(term, []);
			this.activeSearchable?.clearDeeperHits();
			return;
		}
		try {
			const results: SearchResults = await this.getSearchService().query(term, scope);
			this.renderSearchResults(term, results.direct);
			this.activeSearchable?.applyDeeperHits(term, results.deeper);
		} catch (err) {
			console.warn("[neuro-mindmap] search failed", err);
		}
	}

	private renderSearchResults(term: string, hits: SearchHit[]): void {
		const el = this.searchResultsEl;
		if (!el) return;
		el.empty();
		if (!term.trim()) {
			el.addClass("is-empty");
			return;
		}
		el.removeClass("is-empty");

		const head = el.createDiv({ cls: "neuro-search-results-head" });
		head.setText(hits.length === 0
			? `No notes at this level for "${term}"`
			: `${hits.length} note${hits.length === 1 ? "" : "s"} for "${term}"`);

		for (const hit of hits) {
			const row = el.createDiv({ cls: "neuro-search-result-row" });
			row.createDiv({ cls: "neuro-search-result-title", text: hit.title });
			if (hit.snippet) {
				row.createDiv({ cls: "neuro-search-result-snippet", text: hit.snippet });
			}
			row.addEventListener("click", () => {
				void this.app.workspace.getLeaf("split").openFile(hit.file);
			});
		}
	}

	// ── Toolbar ───────────────────────────────────────────────────────────────

	private renderToolbar(): void {
		const toolbar = this.contentEl.createDiv({ cls: "neuro-map-toolbar" });

		if (this.navStack.length > 1) {
			const backBtn = toolbar.createEl("button", { cls: "neuro-map-back-btn", attr: { "aria-label": "Go back" } });
			backBtn.createEl("span", { text: "←" });
			backBtn.addEventListener("click", () => { this.navStack.pop(); this.render(); });
		}

		const crumbs = toolbar.createDiv({ cls: "neuro-map-breadcrumbs" });

		this.navStack.forEach((entry, i) => {
			const isLast = i === this.navStack.length - 1;
			crumbs.createEl("span", {
				text: entry.name,
				cls:  isLast ? "neuro-crumb neuro-crumb--active" : "neuro-crumb",
			});
			if (!isLast) crumbs.createEl("span", { text: " › ", cls: "neuro-crumb-sep" });
		});

		toolbar.createDiv({ cls: "neuro-toolbar-spacer" });
	}

	// ── Note Navigator ────────────────────────────────────────────────────────

	private rebuildNavigator(): void {
		if (!this.navigatorEl) return;
		this.navigatorEl.empty();

		const entry  = this.navStack[this.navStack.length - 1];
		const depth  = this.navStack.length - 1;
		if (!entry) return;

		if (depth === 0) {
			this.buildLevel0Navigator();
		} else if (entry.allenId !== undefined) {
			this.buildLevel1Navigator(entry.allenId);
		}

		// Inner views (viewpoint, cell) contribute their own sections
		// (subregions / focused-layer / placement / compartments) below the
		// region-notes block so the navigator is a single combined panel.
		const stage = entry.stage;
		if (stage === "viewpoint" && this.viewpointView) {
			this.viewpointView.renderNavigatorSections(this.navigatorEl);
		} else if (stage === "cell" && this.cellView) {
			this.cellView.renderNavigatorSections(this.navigatorEl);
		}
	}

	private buildLevel0Navigator(): void {
		const el    = this.navigatorEl!;
		const notes = getAllRegionNotesWithAllen(this.app);

		if (notes.length === 0) {
			el.createDiv({
				cls:  "neuro-nav-empty",
				text: 'No brain region notes yet. Click "+ Add region note" to create one.',
			});
		} else {
			// Group by immediate ancestor
			const groups = new Map<number | null, typeof notes>();
			for (const n of notes) {
				const parentId = n.ancestorIds[0] ?? null;
				const list = groups.get(parentId) ?? [];
				list.push(n);
				groups.set(parentId, list);
			}

			for (const [parentId, groupNotes] of groups) {
				const parentName = parentId !== null
					? (this.structureTree.get(parentId)?.name ?? `Structure ${parentId}`)
					: "Ungrouped";
				el.createDiv({ cls: "neuro-nav-section-label", text: parentName });
				for (const n of groupNotes) {
					const item = el.createDiv({ cls: "neuro-nav-item" });
					item.createSpan({ cls: "neuro-nav-item-icon", text: "🧠" });
					item.createSpan({ cls: "neuro-nav-item-title", text: n.file.basename });
					const viewBtn = item.createEl("button", {
						cls:  "neuro-nav-item-action",
						text: "→",
						attr: { title: "Open 2D slice view", "aria-label": "Open 2D slice view" },
					});
					viewBtn.addEventListener("click", (evt: MouseEvent) => {
						evt.stopPropagation();
						const node = this.structureTree.get(n.allenId);
						this.navStack.push({
							name:    node?.name ?? n.name,
							allenId: n.allenId,
						});
						this.render();
					});
					item.addEventListener("click", () =>
						void this.app.workspace.openLinkText(n.file.path, "")
					);
				}
			}
		}

		// Connections section
		const connNotes = this.app.vault.getMarkdownFiles().filter(f => {
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
			return fm?.entity_type === "connection";
		});
		if (connNotes.length > 0) {
			el.createDiv({ cls: "neuro-nav-section-label", text: "Connections" });
			for (const file of connNotes) {
				const item = el.createDiv({ cls: "neuro-nav-item" });
				item.createSpan({ cls: "neuro-nav-item-icon", text: "↔" });
				item.createSpan({ cls: "neuro-nav-item-title", text: file.basename });
				item.addEventListener("click", () =>
					void this.app.workspace.openLinkText(file.path, "")
				);
			}
		}

		const addBtn = el.createEl("button", { text: "+ Add region note", cls: "neuro-nav-add-btn mod-cta" });
		addBtn.addEventListener("click", () =>
			new CreateBrainRegionNoteModal(this.app, this.plugin, this.structureTree).open()
		);
	}

	private buildLevel1Navigator(allenId: number): void {
		const el    = this.navigatorEl!;
		const notes = getAllNotesForAllenId(this.app, allenId, this.structureTree);
		const node  = this.structureTree.get(allenId);
		const name  = node?.name ?? `Structure ${allenId}`;

		if (notes.length === 0) {
			el.createDiv({
				cls:  "neuro-nav-empty",
				text: `No notes for ${name} yet. Open a viewpoint and focus a subregion to add cells.`,
			});
		} else {
			const regionNotes = notes.filter(f => {
				const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
				return fm?.entity_type === "brain-region";
			});
			const cellNotes = notes.filter(f => {
				const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
				return fm?.entity_type === "cell-type";
			});
			const connNotes = notes.filter(f => {
				const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
				return fm?.entity_type === "connection";
			});

			if (regionNotes.length > 0) {
				el.createDiv({ cls: "neuro-nav-section-label", text: "Region Notes" });
				regionNotes.forEach(f => this.renderNavItem(el, "🧠", f, undefined));
			}
			if (cellNotes.length > 0) {
				el.createDiv({ cls: "neuro-nav-section-label", text: "Cell Types" });
				for (const file of cellNotes) {
					const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as
						Partial<CellTypeFrontmatter> | undefined;
					this.renderNavItem(el, "🔵", file, fm?.layer_id);
				}
			}
			if (connNotes.length > 0) {
				el.createDiv({ cls: "neuro-nav-section-label", text: "Connections" });
				connNotes.forEach(f => this.renderNavItem(el, "↔", f, undefined));
			}
		}
	}

	private renderNavItem(container: HTMLElement, icon: string, file: TFile, badge: string | undefined): void {
		const item = container.createDiv({ cls: "neuro-nav-item" });
		item.createSpan({ cls: "neuro-nav-item-icon", text: icon });
		item.createSpan({ cls: "neuro-nav-item-title", text: file.basename });
		if (badge) item.createSpan({ cls: "neuro-nav-item-badge", text: badge });
		item.addEventListener("click", () => void this.app.workspace.openLinkText(file.path, ""));
	}

	// ── 3D viewer (Level 0) ───────────────────────────────────────────────────

	private render3DViewer(canvas: HTMLElement): void {
		const provider = this.plugin.provider;

		const container = canvas.createDiv({
			cls:  "neuro-3d-container",
			attr: { style: "flex:1;min-height:380px;" },
		});

		const regionNotes = getRegionNoteAllenIds(this.app, this.structureTree);

		this.viewer3D = new BrainViewer3D(container, this.app, {
			app:           this.app,
			cacheDir:      provider.meshCacheDir,
			provider,
			regionNotes,
			structureTree: this.structureTree,
			initialCamera: this.plugin.settings.brain3DCamera ?? undefined,
			onCameraChange: camera => {
				this.plugin.settings.brain3DCamera = camera;
				void this.plugin.saveSettings();
			},
			onRegionClick: (allenId: number) => {
				const node = this.structureTree.get(allenId);
				this.navStack.push({
					name:    node?.name ?? `Structure ${allenId}`,
					allenId,
				});
				this.render();
			},
		});
		this.activeSearchable = this.viewer3D;
	}

	// ── Auto-routing helpers ──────────────────────────────────────────────────

	/** Returns the viewpoint to open by default for a region: the last one the
	 *  user visited (if it still exists), else the first discovered viewpoint,
	 *  else null when no viewpoints exist for the structure. */
	private resolveDefaultViewpoint(allenId: number): TFile | null {
		const last = this.plugin.settings.lastViewpointByAllenId[String(allenId)];
		if (last) {
			const f = this.app.vault.getAbstractFileByPath(last);
			if (f instanceof TFile) {
				const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as
					Partial<ViewpointFrontmatter> | undefined;
				if (fm?.entity_type === "viewpoint" && fm.allen_id === allenId) return f;
			}
		}
		const all = discoverViewpoints(this.app, allenId, `${mouseRoot(this.plugin)}/viewpoints`);
		return all[0] ?? null;
	}

	private viewpointDisplayName(file: TFile): string {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as
			Partial<ViewpointFrontmatter> | undefined;
		return fm?.viewpoint_name ?? file.basename;
	}

	private recordLastViewpoint(allenId: number, file: TFile): void {
		const key = String(allenId);
		const map = this.plugin.settings.lastViewpointByAllenId;
		if (map[key] === file.path) return;
		map[key] = file.path;
		void this.plugin.saveSettings();
	}

	// ── Viewpoint picker (Level 1, stage "picker") ────────────────────────────

	private renderViewpointPicker(canvas: HTMLElement, allenId: number): void {
		const picker = new ViewpointPickerView({
			app:           this.app,
			allenId,
			structureTree:  this.structureTree,
			viewpointsRoot: `${mouseRoot(this.plugin)}/viewpoints`,
			onSelect: (file) => {
				this.navStack.push({
					name:          file.basename,
					allenId,
					stage:         "viewpoint",
					viewpointFile: file,
				});
				this.render();
			},
			onCreateNew: () => {
				const node = this.structureTree.get(allenId);
				this.navStack.push({
					name:    node?.name ?? `Structure ${allenId}`,
					allenId,
					stage:   "slice-picker",
				});
				this.render();
			},
		});
		picker.render(canvas);
	}

	// ── Viewpoint viewer (Level 1, stage "viewpoint") ─────────────────────────

	private renderViewpoint(canvas: HTMLElement, file: TFile): void {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as
			Partial<ViewpointFrontmatter> | undefined;

		const view = new ViewpointView({
			app:  this.app,
			file,
			structureTree: this.structureTree,
			onCreateCell: (layer, siblingAcronyms) => {
				new AddCellModal(this.app, {
					leafAcronym:     layer.acronym,
					leafName:        layer.name,
					leafAllenId:     layer.id,
					siblingAcronyms,
					structureTree:   this.structureTree,
					onPickCandidate: c =>
						void view.beginPlacement({ mode: "create", candidate: c, leafLayer: layer }),
					onPickSchematic: () =>
						void view.beginPlacement({ mode: "create", schematic: true, leafLayer: layer }),
				}).open();
			},
			onOpenCell: (cellFile) => {
				const cfm = this.app.metadataCache.getFileCache(cellFile)?.frontmatter as
					Partial<CellTypeFrontmatter> | undefined;
				this.navStack.push({
					name:     cfm?.cell_name ?? cellFile.basename,
					allenId:  fm?.allen_id,        // keeps breadcrumb consistent with viewpoint context
					stage:    "cell",
					cellFile,
				});
				this.render();
			},
			onShowPicker: () => {
				const top = this.navStack[this.navStack.length - 1];
				if (!top || top.allenId === undefined) return;
				const node = this.structureTree.get(top.allenId);
				top.stage = "picker";
				top.viewpointFile = undefined;
				top.name = node?.name ?? `Structure ${top.allenId}`;
				this.render();
			},
			onRequestNavRebuild: () => this.rebuildNavigator(),
		});
		view.render(canvas);
		this.viewpointView    = view;
		this.activeSearchable = view;
	}

	// ── Cell view (Level 2, stage "cell") ─────────────────────────────────────

	private renderCellView(canvas: HTMLElement, file: TFile): void {
		const view = new CellView({
			app:      this.app,
			file,
			onRequestNavRebuild: () => this.rebuildNavigator(),
		});
		this.cellView         = view;
		this.activeSearchable = view;
		void view.render(canvas);
	}

	// ── Allen section viewer (Level 1+) ───────────────────────────────────────

	private renderAllenSectionViewer(
		canvas:  HTMLElement,
		allenId: number,
		withSliceSelection: boolean = false,
	): void {
		const provider  = this.plugin.provider;
		const node      = this.structureTree.get(allenId);
		const ancestors = node ? getAncestors(allenId, this.structureTree) : [];

		// Plane choice lives on the nav entry while the slice-picker is open;
		// defaults to coronal on first entry.
		const entry = this.navStack[this.navStack.length - 1];
		if (entry && withSliceSelection) {
			entry.pickerPlane ??= "coronal";
		}
		const plane: "coronal" | "sagittal" = entry?.pickerPlane ?? "coronal";

		if (withSliceSelection) {
			this.renderSlicePickerToolbar(canvas, plane, allenId);
		}
		const viewerHost = canvas.createDiv({ cls: "neuro-slice-viewer-host" });

		const viewer = new AllenSectionViewer({
			app:           this.app,
			provider,
			allenId,
			sectionType:   plane,
			structureTree: this.structureTree,
			activeCellNotes:   getActiveCellNotes(this.app, allenId, this.structureTree),
			activeConnections: getActiveConnections(this.app, allenId, this.structureTree),
			onDotClick: (_childAllenId: number, file: TFile | null) => {
				if (file) {
					void this.app.workspace.openLinkText(file.path, "");
				} else {
					new Notice("Cells are created from the viewpoint side panel. Open a viewpoint and focus a subregion to add one.");
				}
			},
			onSliceSelected: withSliceSelection
				? (svgEl: SVGSVGElement, section: AllenAtlasSection) =>
					this.onSliceSelected(allenId, svgEl, section)
				: undefined,
		});
		viewer.render(viewerHost);

		// Update 3D ancestor context — prefetch immediate parents into the mesh cache.
		void (async () => {
			if (ancestors.length === 0) return;
			const meshDir = provider.meshCacheDir;
			const adapter = this.app.vault.adapter;
			for (const ancestor of ancestors.slice(0, 2)) {
				const p = `${meshDir}/${ancestor.id}.obj`;
				if (!(await adapter.exists(p))) {
					try {
						const obj = await provider.fetchStructureMeshObj(ancestor.id);
						await adapter.write(p, obj);
					} catch { /* non-fatal */ }
				}
			}
		})();
	}

	/** Plane chooser shown above the slice picker. Updates the current nav
	 *  entry in place and re-renders the section viewer so the picker
	 *  reflects the new plane immediately. */
	private renderSlicePickerToolbar(
		canvas:  HTMLElement,
		plane:   "coronal" | "sagittal",
		allenId: number,
	): void {
		const bar   = canvas.createDiv({ cls: "neuro-slice-picker-toolbar" });
		const entry = this.navStack[this.navStack.length - 1];

		bar.createSpan({ text: "Plane:", cls: "neuro-slice-picker-label" });
		const group = bar.createDiv({ cls: "neuro-slice-picker-toggle" });
		const options: { value: "coronal" | "sagittal"; label: string }[] = [
			{ value: "coronal",  label: "Coronal"  },
			{ value: "sagittal", label: "Sagittal" },
		];
		for (const opt of options) {
			const btn = group.createEl("button", {
				text: opt.label,
				cls:  opt.value === plane
					? "neuro-slice-picker-btn is-active"
					: "neuro-slice-picker-btn",
			});
			btn.addEventListener("click", () => {
				if (opt.value === plane) return;
				if (entry) entry.pickerPlane = opt.value;
				const canvasPanel = this.contentEl.querySelector(".neuro-canvas-panel") as HTMLElement | null;
				if (canvasPanel) {
					canvasPanel.empty();
					this.renderAllenSectionViewer(canvasPanel, allenId, true);
					this.mountSearchBar(canvasPanel);
				}
			});
		}
	}

	// ── Viewpoint creation callback (from AllenSectionViewer "Use this slice") ─

	private onSliceSelected(
		allenId: number,
		svgEl:   SVGSVGElement,
		section: AllenAtlasSection,
	): void {
		const node = this.structureTree.get(allenId);
		if (!node) {
			new Notice("Cannot build viewpoint — structure not in tree.");
			return;
		}
		const entry = this.navStack[this.navStack.length - 1];
		const plane = entry?.pickerPlane ?? "coronal";

		const descendantIds = getDescendantIds(allenId, this.structureTree);
		const payload = buildViewpointFromSection(
			svgEl,
			allenId,
			node.acronym,
			section.id,
			section.order,
			section.apPositionMm,
			plane,
			descendantIds,
			this.structureTree,
		);

		if (payload.layers.length === 0) {
			new Notice("No subregion polygons found at this slice.");
			return;
		}

		const defaultName = `${node.acronym} ${plane} · AP ${payload.ap_mm.toFixed(2)}`;

		new CreateViewpointModal(
			this.app,
			this.plugin,
			payload,
			defaultName,
			(file: TFile) => {
				// Pop the slice-picker entry and land back on the picker so the
				// new viewpoint appears in the list.
				this.navStack.pop();
				this.navStack.push({
					name:          file.basename,
					allenId,
					stage:         "viewpoint",
					viewpointFile: file,
				});
				this.render();
			},
		).open();
	}
}
