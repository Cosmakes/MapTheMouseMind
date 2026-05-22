// ──────────────────────────────────────────────────────────────────────────────
// main.ts  —  Plugin entry point
// ──────────────────────────────────────────────────────────────────────────────

import { Plugin, WorkspaceLeaf } from "obsidian";
import { CreateConnectionModal } from "./CreateConnectionModal";
import { InsertRegionModal } from "./InsertRegionModal";
import { MapTheMindView, VIEW_TYPE_NEURO_MAP } from "./MapTheMindView";
import { DEFAULT_SETTINGS, NeuroMindmapSettings, NeuroSettingsTab } from "./settings";
import type { AllenStructureFlat } from "./api/allenStructureCache";
import { getProvider, type AtlasProvider } from "./atlas";

export default class NeuroMindmapPlugin extends Plugin {
	settings!: NeuroMindmapSettings;
	provider!: AtlasProvider;
	/** Cached structure tree — populated from `provider.loadStructureTree()` so
	 *  call sites can read it synchronously after `ensureProvider()` has run. */
	structureTree: Map<number, AllenStructureFlat> = new Map();

	async onload(): Promise<void> {
		await this.loadSettings();
		this.provider = getProvider(this.app);

		this.registerView(
			VIEW_TYPE_NEURO_MAP,
			(leaf: WorkspaceLeaf) => new MapTheMindView(leaf, this),
		);

		// ── Commands ───────────────────────────────────────────────────────────
		this.addCommand({
			id: "insert-brain-region-ref",
			name: "Insert brain region reference",
			editorCallback: (editor) => {
				void this.ensureStructureTree().then(() => {
					new InsertRegionModal(
						this.app, editor, this, this.structureTree,
					).open();
				});
			},
		});

		this.addCommand({
			id:   "open-hippocampus-map",
			name: "Open MapTheMind view",
			callback: () => void this.activateMapView(),
		});

		this.addCommand({
			id:       "create-connection-note",
			name:     "Create connection note",
			callback: () => new CreateConnectionModal(this.app, this).open(),
		});

		this.addRibbonIcon("brain", "Open MapTheMind view", () => {
			void this.activateMapView();
		});

		this.addSettingTab(new NeuroSettingsTab(this.app, this));
	}

	onunload(): void { /* Obsidian handles leaf/command/ribbon cleanup */ }

	/** Lazily loads the structure tree on first call; subsequent calls are no-ops. */
	async ensureStructureTree(): Promise<void> {
		if (this.structureTree.size > 0) return;
		try {
			this.structureTree = await this.provider.loadStructureTree();
		} catch (err) {
			console.warn("[neuro-mindmap] Could not load structure tree:", err);
		}
	}

	async activateMapView(): Promise<void> {
		const { workspace } = this.app;

		const existing = workspace.getLeavesOfType(VIEW_TYPE_NEURO_MAP);
		const firstExisting = existing[0];
		if (firstExisting !== undefined) {
			workspace.revealLeaf(firstExisting);
			return;
		}

		const leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf("tab");
		await leaf.setViewState({ type: VIEW_TYPE_NEURO_MAP, active: true });
		workspace.revealLeaf(leaf);
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<NeuroMindmapSettings>,
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
