// ──────────────────────────────────────────────────────────────────────────────
// views/CellView.ts  —  Single-cell morphology view with compartment selection.
//
// Reached by clicking a placed cell glyph inside a viewpoint. Renders the
// cell's full SWC morphology in an SVG (one <g> per compartment). Auxiliary
// controls (compartment chips, per-compartment topic list) are rendered into
// the host's combined navigator panel via `renderNavigatorSections(container)`.
//
// Selection:
//   • Clicking a navigator chip or the SVG branches selects that compartment.
//   • Selected compartment stays at full opacity; others fade (CSS).
//   • The notes list shows only topics scoped to (cell, compartment).
// ──────────────────────────────────────────────────────────────────────────────

import { App, TFile, type EventRef } from "obsidian";
import type { CellTypeFrontmatter, Compartment } from "../types";
import { drawMorphologyNodes, cellClassColor } from "../cellGlyph";
import { fetchNeuronSwc, project2d, type SwcNode } from "../api/neuromorpho";
import { getTopicsForScope } from "../topics";
import type { SearchHit } from "../search";
import { HelpModal } from "../HelpModal";

const SVG_NS = "http://www.w3.org/2000/svg";

const COMPARTMENT_LABELS: Record<Compartment, string> = {
	soma:     "Soma",
	axon:     "Axon",
	basal:    "Basal dendrite",
	apical:   "Apical dendrite",
	dendrite: "Dendrite",
};

/** The compartments rendered as separate sub-groups in the cell view.
 *  "dendrite" is omitted because it's a synonym; basal + apical cover it. */
const RENDERED_COMPARTMENTS: Compartment[] = ["soma", "axon", "basal", "apical"];

export interface CellViewOptions {
	app:  App;
	file: TFile;
	/** Asks the host (MapTheMindView) to rebuild the combined navigator —
	 *  used when this view's local state changes (compartment selection). */
	onRequestNavRebuild?: () => void;
}

export class CellView {
	private readonly opts: CellViewOptions;
	private fm:       Partial<CellTypeFrontmatter> = {};
	private nodes:    SwcNode[] = [];
	private svg:      SVGSVGElement | null = null;
	private compartmentGroups = new Map<Compartment, SVGGElement>();
	private selected: Compartment | null = null;
	private mdListener:  EventRef    | null = null;

	constructor(opts: CellViewOptions) { this.opts = opts; }

	destroy(): void {
		if (this.mdListener) {
			this.opts.app.metadataCache.offref(this.mdListener);
			this.mdListener = null;
		}
	}

	/** Currently-selected compartment, exposed so the host can scope a new
	 *  note's `compartment` field when the user clicks "+ Create note". */
	getSelectedCompartment(): Compartment | null { return this.selected; }

	// ── SearchableView interface ──────────────────────────────────────────────
	// Cells have no deeper level, so deeper hits never apply here.
	applyDeeperHits(_term: string, _hits: SearchHit[]): void { /* no-op */ }
	clearDeeperHits(): void { /* no-op */ }

	async render(container: HTMLElement): Promise<void> {
		container.empty();
		container.addClass("neuro-cell-view");

		this.fm = (this.opts.app.metadataCache.getFileCache(this.opts.file)?.frontmatter ?? {}) as
			Partial<CellTypeFrontmatter>;

		// Refresh the navigator when topic notes change so newly created
		// per-compartment notes appear without needing a navigation round-trip.
		if (!this.mdListener) {
			this.mdListener = this.opts.app.metadataCache.on("changed", () => {
				this.opts.onRequestNavRebuild?.();
			});
		}

		// ── Header ──
		const header = container.createDiv({ cls: "neuro-cell-view-header" });
		header.createEl("span", {
			text: this.fm.cell_name ?? this.opts.file.basename,
			cls:  "neuro-cell-view-title",
		});
		if (this.fm.cell_class) {
			header.createEl("span", {
				text: this.fm.cell_class,
				cls:  "neuro-cell-view-sub",
			});
		}
		header.createDiv({ cls: "neuro-cell-view-spacer" });
		const openBtn = header.createEl("button", {
			text: "Open note",
			cls:  "neuro-cell-view-open-btn",
		});
		openBtn.addEventListener("click", () =>
			void this.opts.app.workspace.getLeaf().openFile(this.opts.file),
		);

		const helpBtn = header.createEl("button", {
			text: "?",
			cls:  "neuro-help-btn neuro-cell-view-help-btn",
			attr: { title: "Help for the cell view" },
		});
		helpBtn.addEventListener("click", () =>
			new HelpModal(this.opts.app, "cell").open(),
		);

		// ── Body ── (SVG fills the whole canvas; the side panel moved into
		// the host's navigator)
		const svgWrap = container.createDiv({ cls: "neuro-cell-view-svg-wrap" });

		if (!this.fm.morphology_source) {
			svgWrap.createEl("p", {
				text: "This cell has no morphology source — add `morphology_source: neuromorpho:<name>` to its frontmatter to view it here.",
				cls:  "neuro-cell-view-empty",
			});
			return;
		}

		svgWrap.createEl("p", { text: "Loading morphology…", cls: "neuro-cell-view-loading" });

		try {
			this.nodes = await fetchNeuronSwc(
				this.fm.morphology_source,
				this.opts.app.vault.adapter,
			);
		} catch (err) {
			svgWrap.empty();
			svgWrap.createEl("p", {
				text: `Failed to load morphology: ${(err as Error).message}`,
				cls:  "neuro-cell-view-error",
			});
			return;
		}

		svgWrap.empty();
		this.renderSvg(svgWrap);
	}

	// ── SVG rendering ─────────────────────────────────────────────────────────

	private renderSvg(parent: HTMLElement): void {
		const projected = project2d(this.nodes, "coronal");
		if (projected.length === 0) {
			parent.createEl("p", {
				text: "Morphology has no projectable points.",
				cls:  "neuro-cell-view-empty",
			});
			return;
		}

		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const p of projected) {
			if (p.x < minX) minX = p.x;
			if (p.y < minY) minY = p.y;
			if (p.x > maxX) maxX = p.x;
			if (p.y > maxY) maxY = p.y;
		}
		const w = maxX - minX || 1;
		const h = maxY - minY || 1;
		const pad = Math.max(w, h) * 0.10;
		const vbX = minX - pad;
		const vbY = minY - pad;
		const vbW = w + pad * 2;
		const vbH = h + pad * 2;

		const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
		svg.setAttribute("xmlns", SVG_NS);
		svg.setAttribute("viewBox", `${vbX} ${vbY} ${vbW} ${vbH}`);
		svg.setAttribute("class", "neuro-cell-view-svg");
		svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
		parent.appendChild(svg);
		this.svg = svg;

		// Treat the morphology bbox as a Centroid so drawMorphologyNodes can
		// auto-fit; the per-compartment override stays at scale = 1.
		const focus = { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w, h };

		this.compartmentGroups.clear();
		for (const c of RENDERED_COMPARTMENTS) {
			const g = document.createElementNS(SVG_NS, "g") as SVGGElement;
			g.setAttribute("class", `neuro-cell-view-compartment compartment-${c}`);
			g.setAttribute("data-compartment", c);
			svg.appendChild(g);
			this.compartmentGroups.set(c, g);

			// Soma is rendered at the end of drawMorphologyNodes when "soma" is
			// in the compartments set, so the soma group only needs that filter.
			drawMorphologyNodes(g, focus, this.fm, "coronal", this.nodes,
				{ compartments: new Set([c]) });

			g.addEventListener("click", evt => {
				evt.stopPropagation();
				this.toggleSelection(c);
			});
		}

		// Click on empty SVG clears selection.
		svg.addEventListener("click", () => this.toggleSelection(null));
	}

	private toggleSelection(c: Compartment | null): void {
		if (c !== null && this.selected === c) {
			this.selected = null;
		} else {
			this.selected = c;
		}
		this.applySelectionClasses();
		this.opts.onRequestNavRebuild?.();
	}

	private applySelectionClasses(): void {
		if (!this.svg) return;
		const classes = ["neuro-cell-view-svg"];
		if (this.selected) classes.push("has-selection", `selected-${this.selected}`);
		this.svg.setAttribute("class", classes.join(" "));
		for (const [c, g] of this.compartmentGroups) {
			const baseCls = `neuro-cell-view-compartment compartment-${c}`;
			g.setAttribute("class", c === this.selected ? `${baseCls} is-selected` : baseCls);
		}
	}

	// ── Navigator sections (rendered by host into combined navigator) ────────

	/** Called by MapTheMindView from rebuildNavigator() after the region-notes
	 *  block. We append compartment chips and the per-(cell,compartment)
	 *  topic list. */
	renderNavigatorSections(container: HTMLElement): void {
		this.renderCompartmentSection(container);
		this.renderTopicsSection(container);
	}

	private renderCompartmentSection(panel: HTMLElement): void {
		const section = panel.createEl("details", { cls: "neuro-side-section" });
		section.setAttr("open", "true");
		const head = section.createEl("summary", { cls: "neuro-side-section-head" });
		head.createSpan({ text: "Compartments" });

		const chips = section.createDiv({ cls: "neuro-cell-view-chips" });
		const colorVar = cellClassColor(this.fm.cell_class ?? "other");
		for (const c of RENDERED_COMPARTMENTS) {
			const chip = chips.createDiv({ cls: "neuro-cell-view-chip" });
			if (c === this.selected) chip.addClass("is-selected");
			const swatch = chip.createDiv({ cls: "neuro-cell-view-chip-swatch" });
			swatch.style.background = `var(${colorVar})`;
			chip.createSpan({ text: COMPARTMENT_LABELS[c] });
			chip.addEventListener("click", () => this.toggleSelection(c));
		}
	}

	private renderTopicsSection(panel: HTMLElement): void {
		const section = panel.createEl("details", { cls: "neuro-side-section" });
		section.setAttr("open", "true");
		const head = section.createEl("summary", { cls: "neuro-side-section-head" });
		head.createSpan({
			text: this.selected
				? `Notes for ${COMPARTMENT_LABELS[this.selected].toLowerCase()}`
				: "Notes for this cell",
		});

		const cellKey = this.opts.file.basename;
		const query: { cell: string; compartment?: Compartment } = { cell: cellKey };
		if (this.selected) query.compartment = this.selected;
		const topics = getTopicsForScope(this.opts.app, query);

		const list = section.createDiv({ cls: "neuro-cell-view-topic-list" });
		if (topics.length === 0) {
			list.createEl("p", {
				text: "No notes yet.",
				cls:  "neuro-cell-view-empty-row",
			});
			return;
		}
		for (const topic of topics) {
			const row = list.createDiv({ cls: "neuro-cell-view-topic-row" });
			const tfm = this.opts.app.metadataCache.getFileCache(topic)?.frontmatter as
				{ topic_name?: string } | undefined;
			row.createSpan({
				text: tfm?.topic_name ?? topic.basename,
				cls:  "neuro-cell-view-topic-name",
			});
			row.addEventListener("click", () =>
				void this.opts.app.workspace.getLeaf().openFile(topic),
			);
		}
	}
}
