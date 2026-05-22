// ──────────────────────────────────────────────────────────────────────────────
// views/ViewpointView.ts  —  Labeled schematic of one Allen slice for a region.
//
// The view fills its container with the schematic SVG. Auxiliary controls
// (subregion list, focused-layer detail, placement controls, compartment
// toggles) are rendered into the host's combined navigator panel via
// `renderNavigatorSections(container)` — the host calls this after the
// canvas-wide region-notes section.
//
// Behaviour:
//   • Polygons are styled via CSS variables (.neuro-viewpoint-layer), with
//     two modifiers:
//       .is-cell-dense — darker default for layers whose name identifies them
//                        as cell-body-rich (pyramidal / granule / Purkinje / …)
//       .is-focused    — the currently selected layer
//   • Hover shows a floating "<name> [<acronym>]" tooltip near the cursor.
//   • Click toggles focus. While focused, the navigator's focused-layer
//     section exposes "+ Add cell"; schematic glyphs + optional SWC
//     morphology render on top of the polygon.
//   • Rotation buttons in the header step content by ±90° around the viewBox
//     centre. Pan / zoom are provided by the shared svgPanZoom helper and
//     operate on a squared viewBox sized to contain the rotated content.
// ──────────────────────────────────────────────────────────────────────────────

import { Notice, parseYaml, stringifyYaml, type App, type EventRef, type TFile } from "obsidian";
import type {
	CellClass,
	CellTypeFrontmatter,
	Placement,
	ViewpointFrontmatter,
	ViewpointLayer,
} from "../types";
import { cellsFolderForViewpoint, getCellTypesForLayer, parseViewpointBody } from "../viewpoints";
import { HelpModal } from "../HelpModal";
import { attachPanZoom, PanZoomHandle } from "../svgPanZoom";
import {
	drawCellGlyph,
	drawMorphology,
	drawMorphologyNodes,
	Centroid,
	Compartment,
} from "../cellGlyph";
import { fetchNeuronSwc, type SwcNode } from "../api/neuromorpho";
import type { MorphologyCandidate } from "../api/morphologySource";
import type { SearchHit } from "../search";
import type { AllenStructureFlat } from "../api/allenStructureCache";
import { renderPreviewCard } from "./SearchPreviewCard";

const SVG_NS = "http://www.w3.org/2000/svg";

/** When more than this many anchors have hits, only the top-N by hit-count
 *  render as expanded cards; the rest collapse to dots that expand on hover. */
const EXPANDED_CARD_LIMIT = 3;
/** Minimum distance, in screen pixels, between a preview card's centre and
 *  its anchor dot. Mandatory: the layout searches for an angle that keeps
 *  the card on-canvas at this distance rather than reducing the gap. */
const CARD_OUTWARD_OFFSET_PX = 200;
/** Padding (px) kept between adjacent cards when resolving overlaps. */
const CARD_OVERLAP_PAD_PX = 12;
/** Padding (px) between a card edge and the canvas edge after clamping. */
const CARD_EDGE_PAD_PX = 10;
/** Step (px) by which an overlapping card is pushed further outward per
 *  iteration, and the iteration cap. */
const CARD_PUSH_STEP_PX  = 18;
const CARD_PUSH_MAX_ITER = 40;

/** One spatial group of hits — typically all hits sharing a `cellId` placed
 *  at the same SVG coordinates. Each anchor owns both a `dot` (always
 *  rendered) and a `card`; CSS classes control which is visible. */
interface SearchAnchor {
	/** Anchor coordinates in viewBox space (pre-rotation). */
	x:    number;
	y:    number;
	hits: SearchHit[];
	/** Sort rank — 0 is the highest-mention anchor. */
	rank: number;
	/** Whether currently rendered as an expanded card (vs. only a dot). */
	expanded: boolean;
	dot:  HTMLDivElement;
	card: HTMLDivElement;
	/** Leader-line element in the overlay's SVG layer (only present for
	 *  expanded cards; null when collapsed). */
	line: SVGLineElement | null;
}

export interface ViewpointViewOptions {
	app:          App;
	file:         TFile;
	/** Allen structure tree — used to render region-acronym chips inside the
	 *  search-result preview cards. */
	structureTree: Map<number, AllenStructureFlat>;
	/** Invoked when the user presses "+ Add cell" inside a focused layer. */
	onCreateCell:  (layer: ViewpointLayer, siblingAcronyms: string[]) => void;
	/** Invoked when the user clicks on a placed cell glyph / morphology. */
	onOpenCell?:   (file: TFile) => void;
	/** Invoked when the user wants to switch back to the viewpoint picker. */
	onShowPicker?: () => void;
	/** Asks the host (MapTheMindView) to rebuild the combined navigator —
	 *  used when this view's local state changes (focused layer, hidden
	 *  cells, compartment toggles, placement mode). */
	onRequestNavRebuild?: () => void;
}

/**
 * Seed for `beginPlacement`. The view fills in defaults and constructs the
 * mutable session internally.
 */
export type PlacementSeed =
	| { mode: "create"; candidate: MorphologyCandidate; leafLayer: ViewpointLayer }
	| { mode: "create"; schematic: true;               leafLayer: ViewpointLayer }
	| { mode: "edit";   file: TFile;                    leafLayer: ViewpointLayer };

interface PlacementSession {
	mode:        "create" | "edit";
	candidate?:  MorphologyCandidate;
	schematic?:  boolean;
	file?:       TFile;                        // edit-mode source
	leafLayer:   ViewpointLayer;               // home subregion
	leafCentroid: Centroid;                    // used as `focus` for renderer
	placement:   Placement;                    // mutable
	cellName:    string;                       // editable
	cellClass:   CellClass;                    // editable for new schematic
	morphIdent?: string;                       // for create+morphology / edit
	swcNodes?:   SwcNode[];                    // pre-fetched for snappy live render
	dragging:    boolean;
	dragLast?:   { x: number; y: number };     // viewBox coords
}

export class ViewpointView {
	private opts: ViewpointViewOptions;

	// Rendering state
	private panZoom: PanZoomHandle | null = null;
	private rotation = 0;
	private viewBoxCenter: { cx: number; cy: number } = { cx: 0, cy: 0 };
	private viewBoxSide:   number = 1000;
	private svg:          SVGSVGElement | null = null;
	private svgWrap:      HTMLElement   | null = null;
	private rotatorGroup: SVGGElement    | null = null;
	private cellGroup:    SVGGElement    | null = null;
	private morphGroup:   SVGGElement    | null = null;
	private previewGroup: SVGGElement    | null = null;
	private searchHits:   SearchHit[] = [];
	private searchTerm:   string = "";
	private tooltipEl:    HTMLDivElement | null = null;

	// Search-overlay (HTML, sits above the SVG in svgWrap).
	private searchOverlayEl: HTMLDivElement | null = null;
	/** SVG layer that holds leader lines connecting each visible card to its
	 *  anchor dot. Lives inside searchOverlayEl, sized to match. */
	private searchLinesEl:   SVGSVGElement  | null = null;
	/** Per-anchor bookkeeping so we can re-position without re-rendering. */
	private searchAnchors: SearchAnchor[] = [];
	/** Index of the anchor whose card is currently being expanded by a dot
	 *  hover (taking the slot of the lowest-ranked default-expanded anchor).
	 *  null when no swap is in effect. */
	private hoverPromotedRank: number | null = null;
	private viewBoxObserver: MutationObserver | null = null;
	private rotatorObserver: MutationObserver | null = null;
	private overlayResizeObserver: ResizeObserver | null = null;

	// Placement mode (interactive cell placement)
	private placement: PlacementSession | null = null;
	private placementKeyHandler: ((evt: KeyboardEvent) => void) | null = null;

	// Content state
	private layers: ViewpointLayer[] = [];
	private centroids = new Map<string, Centroid>();
	private pathByLayerId = new Map<number, SVGPathElement>();
	private plane: "coronal" | "sagittal" = "coronal";

	// Interaction state
	private focusedLayerId: number | null = null;

	// Cached host-supplied container for the placement section, used by
	// refreshPlacementInputs() to update inputs without a full re-render.
	private placementSectionEl: HTMLElement | null = null;

	/** Compartments to render for SWC morphologies. Not persisted. */
	private visibleCompartments: Set<Compartment> =
		new Set<Compartment>(["soma", "dendrite", "axon"]);

	/** Cell-note paths the user has unchecked in the side panel. Not persisted. */
	private hiddenCells: Set<string> = new Set<string>();

	// Metadata-cache subscription
	private mdListener: EventRef | null = null;

	// Debounced rotation persistence
	private rotationSaveTimer: number | null = null;
	private rotationSlider: HTMLInputElement | null = null;
	private rotationReadout: HTMLElement | null = null;

	constructor(opts: ViewpointViewOptions) { this.opts = opts; }

	destroy(): void {
		this.panZoom?.destroy();
		this.panZoom = null;
		if (this.mdListener) {
			this.opts.app.metadataCache.offref(this.mdListener);
			this.mdListener = null;
		}
		if (this.rotationSaveTimer !== null) {
			window.clearTimeout(this.rotationSaveTimer);
			this.rotationSaveTimer = null;
			// Flush the pending rotation so we don't lose it on quick close.
			void this.persistRotation();
		}
		this.detachPlacementHandlers();
		this.teardownOverlayObservers();
	}

	render(container: HTMLElement): void {
		container.empty();
		container.addClass("neuro-viewpoint-viewer");

		const fm = this.opts.app.metadataCache.getFileCache(this.opts.file)?.frontmatter as
			Partial<ViewpointFrontmatter> | undefined;
		this.rotation = fm?.view_rotation ?? 0;

		// Re-render auxiliary state when any relevant note changes (cell-type
		// edits). Viewpoint body changes don't re-render the SVG — user can
		// reopen the viewpoint for that.
		if (!this.mdListener) {
			this.mdListener = this.opts.app.metadataCache.on("changed", () => {
				this.opts.onRequestNavRebuild?.();
				this.applyLayerClasses();
				this.renderCellOverlay();
			});
		}

		// ── Header ──
		const header = container.createDiv({ cls: "neuro-viewpoint-header" });
		header.createEl("span", {
			text: fm?.viewpoint_name ?? this.opts.file.basename,
			cls:  "neuro-viewpoint-title",
		});
		if (fm?.ap_mm !== undefined && fm.plane) {
			header.createEl("span", {
				text: `${fm.plane} · AP ${fm.ap_mm.toFixed(2)} mm`,
				cls:  "neuro-viewpoint-sub",
			});
		}

		header.createDiv({ cls: "neuro-viewpoint-header-spacer" });

		// Rotation slider — smooth, persisted on debounced settle.
		const ctrlGroup = header.createDiv({ cls: "neuro-viewpoint-ctrl-group" });
		ctrlGroup.createEl("span", {
			text: "Rotate", cls: "neuro-viewpoint-ctrl-label",
		});
		const rotSlider = ctrlGroup.createEl("input", {
			cls:  "neuro-viewpoint-rot-slider",
			attr: { type: "range", min: "-180", max: "180", step: "1",
			        title: "Rotate the viewpoint" },
		}) as HTMLInputElement;
		rotSlider.value = this.signedRotation().toString();
		const readout = ctrlGroup.createEl("span", {
			text: this.formatRotation(),
			cls:  "neuro-viewpoint-rot-readout",
		});
		this.rotationSlider  = rotSlider;
		this.rotationReadout = readout;
		rotSlider.addEventListener("input", () => {
			const v = Number(rotSlider.value);
			if (!Number.isFinite(v)) return;
			this.rotation = v;
			this.applyRotation();
			readout.setText(this.formatRotation());
			this.scheduleRotationSave();
		});

		const resetBtn = ctrlGroup.createEl("button", {
			text: "⟲", cls: "neuro-viewpoint-ctrl-btn",
			attr: { title: "Reset rotation and pan/zoom" },
		});
		resetBtn.addEventListener("click",  () => this.resetView());

		if (this.opts.onShowPicker) {
			const pickerBtn = header.createEl("button", {
				text: "Viewpoints",
				cls:  "neuro-viewpoint-picker-btn",
				attr: { title: "Browse all viewpoints for this region" },
			});
			pickerBtn.addEventListener("click", () => this.opts.onShowPicker?.());
		}

		const openBtn = header.createEl("button", {
			text: "Open note",
			cls:  "neuro-viewpoint-open-btn",
		});
		openBtn.addEventListener("click", () =>
			void this.opts.app.workspace.getLeaf().openFile(this.opts.file),
		);

		const helpBtn = header.createEl("button", {
			text: "?",
			cls:  "neuro-viewpoint-ctrl-btn neuro-viewpoint-help-btn",
			attr: { title: "How this plugin works" },
		});
		helpBtn.addEventListener("click", () => new HelpModal(this.opts.app, "viewpoint").open());

		// ── Body ──
		const svgWrap = container.createDiv({ cls: "neuro-viewpoint-svg-wrap" });
		svgWrap.createEl("p", { text: "Loading…", cls: "neuro-viewpoint-loading" });

		void this.loadAndRender(svgWrap, fm);
	}

	// ── Data loading ──────────────────────────────────────────────────────────

	private async loadAndRender(
		svgWrap: HTMLElement,
		fm:      Partial<ViewpointFrontmatter> | undefined,
	): Promise<void> {
		let content: string;
		try {
			content = await this.opts.app.vault.read(this.opts.file);
		} catch (err) {
			svgWrap.empty();
			svgWrap.createEl("p", {
				text: `Failed to read viewpoint: ${(err as Error).message}`,
				cls:  "neuro-viewpoint-error",
			});
			return;
		}

		const parsed = parseViewpointBody(content);
		if (!parsed || parsed.layers.length === 0) {
			svgWrap.empty();
			svgWrap.createEl("p", {
				text: "This viewpoint has no polygon data.",
				cls:  "neuro-viewpoint-error",
			});
			return;
		}

		// metadataCache hasn't always indexed a freshly-created viewpoint
		// note by the time the user navigates into it, so fall back to
		// parsing the YAML frontmatter directly from the file contents.
		const effectiveFm = fm ?? parseFrontmatterFromContent(content);

		this.layers = parsed.layers;
		this.plane  = effectiveFm?.plane ?? "coronal";
		this.rotation = effectiveFm?.view_rotation ?? this.rotation;

		svgWrap.empty();
		this.drawViewpoint(svgWrap, effectiveFm?.view_box ?? "0 0 1000 1000");
		this.opts.onRequestNavRebuild?.();
	}

	// ── SVG construction ──────────────────────────────────────────────────────

	private drawViewpoint(svgWrap: HTMLElement, rawViewBox: string): void {
		const { x, y, w, h } = parseViewBox(rawViewBox);
		const cx = x + w / 2;
		const cy = y + h / 2;
		this.viewBoxCenter = { cx, cy };

		// Square viewBox sized to fit any 90° rotation of the original bounds.
		const side = Math.max(w, h);
		this.viewBoxSide = side;
		const sqX  = cx - side / 2;
		const sqY  = cy - side / 2;
		const squareViewBox = `${sqX} ${sqY} ${side} ${side}`;

		const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
		svg.setAttribute("xmlns",   SVG_NS);
		svg.setAttribute("viewBox", squareViewBox);
		svg.setAttribute("class",   "neuro-viewpoint-svg");
		this.svg = svg;

		const rotator = document.createElementNS(SVG_NS, "g") as SVGGElement;
		rotator.setAttribute("class", "neuro-viewpoint-rotator");
		this.rotatorGroup = rotator;
		this.applyRotation();    // honours `view_rotation` loaded from frontmatter

		const polyGroup    = document.createElementNS(SVG_NS, "g");
		const morphGroup   = document.createElementNS(SVG_NS, "g");
		const cellGroup    = document.createElementNS(SVG_NS, "g");
		const previewGroup = document.createElementNS(SVG_NS, "g") as SVGGElement;
		const labelGroup   = document.createElementNS(SVG_NS, "g");
		polyGroup.setAttribute("class",    "neuro-viewpoint-polys");
		morphGroup.setAttribute("class",   "neuro-viewpoint-morph");
		cellGroup.setAttribute("class",    "neuro-viewpoint-cells");
		previewGroup.setAttribute("class", "neuro-placement-preview");
		labelGroup.setAttribute("class",   "neuro-viewpoint-labels");
		this.cellGroup    = cellGroup;
		this.morphGroup   = morphGroup;
		this.previewGroup = previewGroup;

		this.pathByLayerId.clear();
		this.centroids.clear();

		for (const layer of this.layers) {
			const path = document.createElementNS(SVG_NS, "path") as SVGPathElement;
			path.setAttribute("d",             layer.d);
			path.setAttribute("data-allen-id", layer.id.toString());
			polyGroup.appendChild(path);
			this.pathByLayerId.set(layer.id, path);
		}

		rotator.appendChild(polyGroup);
		rotator.appendChild(morphGroup);
		rotator.appendChild(cellGroup);
		rotator.appendChild(previewGroup);
		rotator.appendChild(labelGroup);
		svg.appendChild(rotator);
		svgWrap.appendChild(svg);

		// HTML overlay for search-result preview cards. Sits on top of the SVG
		// inside the same wrapper so it can use absolute positioning relative
		// to the canvas. We track svgWrap so reposition logic can compute
		// overlay-relative offsets via getBoundingClientRect.
		this.svgWrap = svgWrap;
		this.searchOverlayEl = svgWrap.createDiv({ cls: "neuro-search-preview-overlay" });
		this.installOverlayObservers();

		this.applyLayerClasses();

		// Measure centroids after DOM attachment and place labels.
		for (const layer of this.layers) {
			const path = this.pathByLayerId.get(layer.id);
			if (!path) continue;
			let bb: DOMRect;
			try { bb = path.getBBox(); } catch { continue; }
			if (bb.width === 0 && bb.height === 0) continue;

			const centroid: Centroid = {
				cx: bb.x + bb.width  / 2,
				cy: bb.y + bb.height / 2,
				w:  bb.width,
				h:  bb.height,
			};
			this.centroids.set(layer.acronym.toLowerCase(), centroid);

			const text = document.createElementNS(SVG_NS, "text") as SVGTextElement;
			text.setAttribute("x",                 centroid.cx.toString());
			text.setAttribute("y",                 centroid.cy.toString());
			text.setAttribute("text-anchor",       "middle");
			text.setAttribute("dominant-baseline", "middle");
			text.setAttribute("class",             "neuro-viewpoint-label");
			text.style.pointerEvents = "none";
			text.textContent = layer.acronym;
			labelGroup.appendChild(text);
		}

		// Tooltip (page-layer div, positioned absolute within svgWrap).
		this.tooltipEl = svgWrap.createDiv({ cls: "neuro-viewpoint-tooltip" });
		this.tooltipEl.style.display = "none";

		// Hover + click handlers.
		for (const layer of this.layers) {
			const path = this.pathByLayerId.get(layer.id);
			if (!path) continue;
			path.addEventListener("mouseenter", () => {
				path.classList.add("is-hover");
				if (this.tooltipEl) {
					this.tooltipEl.setText(`${layer.acronym} — ${layer.name}`);
					this.tooltipEl.style.display = "block";
				}
			});
			path.addEventListener("mousemove", (evt: MouseEvent) => {
				if (!this.tooltipEl) return;
				const box = svgWrap.getBoundingClientRect();
				this.tooltipEl.style.left = `${evt.clientX - box.left + 14}px`;
				this.tooltipEl.style.top  = `${evt.clientY - box.top  - 34}px`;
			});
			path.addEventListener("mouseleave", () => {
				path.classList.remove("is-hover");
				if (this.tooltipEl) this.tooltipEl.style.display = "none";
			});
			path.addEventListener("click", () => this.toggleFocus(layer));
		}

		this.panZoom = attachPanZoom(svg);
		this.renderCellOverlay();
	}

	// ── Layer class application ───────────────────────────────────────────────

	private applyLayerClasses(): void {
		for (const layer of this.layers) {
			const path = this.pathByLayerId.get(layer.id);
			if (!path) continue;
			const classes = ["neuro-viewpoint-layer"];
			if (isCellDenseLayer(layer.name))                              classes.push("is-cell-dense");
			if (this.focusedLayerId === layer.id)                          classes.push("is-focused");
			path.setAttribute("class", classes.join(" "));
		}
	}

	// ── Rotation ──────────────────────────────────────────────────────────────

	private applyRotation(): void {
		if (!this.rotatorGroup) return;
		const { cx, cy } = this.viewBoxCenter;
		this.rotatorGroup.setAttribute("transform", `rotate(${this.rotation} ${cx} ${cy})`);
	}

	/** Slider value: rotation normalised into (-180, 180]. Internal state can
	 *  hold any value; this is just for display + slider position. */
	private signedRotation(): number {
		const r = ((this.rotation % 360) + 360) % 360;
		return r > 180 ? r - 360 : r;
	}

	private formatRotation(): string {
		return `${Math.round(this.signedRotation())}°`;
	}

	private scheduleRotationSave(): void {
		if (this.rotationSaveTimer !== null) {
			window.clearTimeout(this.rotationSaveTimer);
		}
		this.rotationSaveTimer = window.setTimeout(() => {
			this.rotationSaveTimer = null;
			void this.persistRotation();
		}, 300);
	}

	private async persistRotation(): Promise<void> {
		const value = this.signedRotation();
		try {
			await this.opts.app.fileManager.processFrontMatter(this.opts.file, fm => {
				if (value === 0) {
					if ("view_rotation" in fm) delete fm.view_rotation;
				} else {
					fm.view_rotation = value;
				}
			});
		} catch (err) {
			console.warn("[neuro-mindmap] failed to persist viewpoint rotation:", err);
		}
	}

	private resetView(): void {
		this.rotation = 0;
		this.applyRotation();
		this.panZoom?.reset();
		if (this.rotationSlider)  this.rotationSlider.value = "0";
		if (this.rotationReadout) this.rotationReadout.setText(this.formatRotation());
		this.scheduleRotationSave();
	}

	// ── Focus / selection ─────────────────────────────────────────────────────

	private toggleFocus(layer: ViewpointLayer): void {
		if (this.focusedLayerId === layer.id) {
			this.focusedLayerId = null;
		} else {
			this.focusedLayerId = layer.id;
		}
		this.applyLayerClasses();
		this.renderCellOverlay();
		this.opts.onRequestNavRebuild?.();
	}

	// ── Cell overlay (soma + arbors + SWC morphology) ─────────────────────────

	private renderCellOverlay(): void {
		if (!this.cellGroup || !this.morphGroup) return;
		this.cellGroup.empty();
		this.morphGroup.empty();

		const vpKey         = this.viewpointKey();
		const editingPath   = this.placement?.mode === "edit" ? this.placement.file?.path : undefined;

		// Iterate every layer in the viewpoint so each cell renders inside its
		// own home subregion, regardless of which (if any) layer is focused.
		// Cells with a stored placement for this viewpoint use that; the rest
		// fall back to layer-centroid + auto-spread so prior behaviour holds.
		for (const layer of this.layers) {
			const layerFocus = this.centroids.get(layer.acronym.toLowerCase());
			if (!layerFocus) continue;
			const allFiles = this.cellsForLayer(layer.acronym)
				.filter(f => !this.hiddenCells.has(f.path) && f.path !== editingPath);
			if (allFiles.length === 0) continue;

			// Auto-spread only applies to cells *without* a stored placement.
			const autoFiles = allFiles.filter(f => {
				const fm = this.opts.app.metadataCache.getFileCache(f)?.frontmatter as
					Partial<CellTypeFrontmatter> | undefined;
				return !fm?.placements?.[vpKey];
			});
			const horizontal = layerFocus.w >= layerFocus.h;
			const span       = (horizontal ? layerFocus.w : layerFocus.h) * 0.55;
			let autoIdx = 0;

			for (const file of allFiles) {
				const fm = this.opts.app.metadataCache.getFileCache(file)?.frontmatter as
					Partial<CellTypeFrontmatter> | undefined;
				if (!fm) continue;

				const stored = fm.placements?.[vpKey];
				let focus: Centroid;
				let glyphPlacement: { cx: number; cy: number } | undefined;
				let morphPlacement: { cx: number; cy: number; scale: number; rotation: number } | undefined;

				if (stored) {
					focus = layerFocus;  // base for soma-radius/auto-fit; overridden via placement
					glyphPlacement = { cx: stored.x, cy: stored.y };
					morphPlacement = { cx: stored.x, cy: stored.y, scale: stored.scale, rotation: stored.rotation };
				} else {
					const offset = autoFiles.length > 1
						? (autoIdx - (autoFiles.length - 1) / 2) * (span / autoFiles.length)
						: 0;
					autoIdx++;
					focus = {
						cx: layerFocus.cx + (horizontal ? offset : 0),
						cy: layerFocus.cy + (horizontal ? 0 : offset),
						w:  layerFocus.w,
						h:  layerFocus.h,
					};
				}

				// Each cell is wrapped in its own clickable sub-group so the
				// user can drill into the cell view by clicking the morphology.
				const parentGroup = fm.morphology_source ? this.morphGroup! : this.cellGroup!;
				const cellSubGroup = document.createElementNS(SVG_NS, "g") as SVGGElement;
				cellSubGroup.setAttribute("class", "neuro-cell-clickable");
				cellSubGroup.setAttribute("data-cell-path", file.path);
				parentGroup.appendChild(cellSubGroup);
				this.attachCellClickHandler(cellSubGroup, file);

				if (fm.morphology_source) {
					// Morphology renders its own (anatomically-sized) soma —
					// the schematic glyph would add a large coloured dot on top.
					void drawMorphology(
						cellSubGroup, focus, fm, this.plane, this.opts.app.vault.adapter,
						{ compartments: this.visibleCompartments, placement: morphPlacement },
					);
				} else {
					drawCellGlyph(cellSubGroup, focus, fm, this.centroids,
						glyphPlacement ? { placement: glyphPlacement } : undefined);
				}
			}
		}

		// Re-render the placement preview on top, using the live session state.
		this.renderPlacementPreview();
	}

	// ── SearchableView interface ──────────────────────────────────────────────

	applyDeeperHits(term: string, hits: SearchHit[]): void {
		this.searchTerm = term;
		this.searchHits = hits;
		this.renderSearchOverlay();
	}

	clearDeeperHits(): void {
		this.searchTerm = "";
		this.searchHits = [];
		this.renderSearchOverlay();
	}

	/** Builds preview-card anchors for every cell whose deeper-level hits
	 *  include it. Top-N anchors (by hit-count) render as cards offset
	 *  outward from the brain centre with a leader line; the rest render as
	 *  dots only. Hovering a dot temporarily promotes its card into the
	 *  visible-card set, demoting the lowest-ranked default-expanded anchor
	 *  into a dot. Cells without a placement (auto-spread fallback) are
	 *  skipped — pinning a card to an auto-positioned cell would lie about a
	 *  position that drifts as more cells are added. */
	private renderSearchOverlay(): void {
		const overlay = this.searchOverlayEl;
		if (!overlay) return;

		// Tear down any prior anchors + lines before rebuilding.
		overlay.empty();
		this.searchAnchors = [];
		this.searchLinesEl = null;
		this.hoverPromotedRank = null;
		if (this.searchHits.length === 0) return;

		const vpKey = this.viewpointKey();
		const byCell = new Map<string, SearchHit[]>();
		for (const h of this.searchHits) {
			if (!h.cellId) continue;
			const list = byCell.get(h.cellId) ?? [];
			list.push(h);
			byCell.set(h.cellId, list);
		}
		if (byCell.size === 0) return;

		const folder = this.cellsFolder();
		const cellsHere = this.opts.app.vault.getMarkdownFiles().filter(f =>
			f.path.startsWith(`${folder}/`),
		);

		// Collect every renderable anchor with its (cellId → hits) and placement.
		const candidates: { x: number; y: number; hits: SearchHit[] }[] = [];
		for (const file of cellsHere) {
			const hits = byCell.get(file.basename);
			if (!hits) continue;
			const fm = this.opts.app.metadataCache.getFileCache(file)?.frontmatter as
				Partial<CellTypeFrontmatter> | undefined;
			const placement = fm?.placements?.[vpKey];
			if (!placement) continue;
			candidates.push({ x: placement.x, y: placement.y, hits });
		}
		if (candidates.length === 0) return;

		// Top-N by hit count are expanded; tie-break by title for stability.
		candidates.sort((a, b) => {
			if (b.hits.length !== a.hits.length) return b.hits.length - a.hits.length;
			const at = a.hits[0]?.title ?? "";
			const bt = b.hits[0]?.title ?? "";
			return at.localeCompare(bt);
		});

		// Single SVG layer for every leader line. Sized in repositionSearchOverlay.
		const linesSvg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
		linesSvg.setAttribute("class", "neuro-search-preview-lines");
		overlay.appendChild(linesSvg);
		this.searchLinesEl = linesSvg;

		for (let i = 0; i < candidates.length; i++) {
			const c = candidates[i]!;
			const expanded = i < EXPANDED_CARD_LIMIT;

			const dot = overlay.createDiv({ cls: "neuro-search-preview-dot is-entering" });
			dot.setAttr("title",
				`${c.hits.length} note${c.hits.length === 1 ? "" : "s"}: `
				+ c.hits.map(h => h.title).join(", "));

			const card = overlay.createDiv({ cls: "neuro-search-preview-card-wrap is-entering" });
			renderPreviewCard(card, {
				app:    this.opts.app,
				tree:   this.opts.structureTree,
				term:   this.searchTerm,
				hits:   c.hits,
				onOpen: file => void this.opts.app.workspace.getLeaf("split").openFile(file),
			});

			const anchor: SearchAnchor = {
				x: c.x, y: c.y, hits: c.hits, rank: i, expanded, dot, card, line: null,
			};
			this.searchAnchors.push(anchor);

			// Hover swap: when a *collapsed* anchor's dot is hovered, promote
			// it into the visible-card set and demote the lowest-ranked
			// default-expanded anchor. This keeps exactly EXPANDED_CARD_LIMIT
			// cards on screen at any moment, so dense regions stay readable.
			dot.addEventListener("mouseenter", () => {
				if (anchor.rank < EXPANDED_CARD_LIMIT) return;
				this.hoverPromotedRank = anchor.rank;
				this.applyAnchorVisibility();
			});
			dot.addEventListener("mouseleave", () => {
				if (this.hoverPromotedRank === anchor.rank) {
					this.hoverPromotedRank = null;
					this.applyAnchorVisibility();
				}
			});
		}

		this.applyAnchorVisibility();
		this.repositionSearchOverlay();
	}

	/** Decides which anchors render their card vs. only their dot, based on
	 *  rank + the optional hover-promotion. Always shows EXPANDED_CARD_LIMIT
	 *  cards (or fewer if there aren't enough anchors). */
	private applyAnchorVisibility(): void {
		const linesSvg = this.searchLinesEl;
		if (!linesSvg) return;

		// Build the set of ranks whose card should be visible.
		const visible = new Set<number>();
		for (let r = 0; r < Math.min(EXPANDED_CARD_LIMIT, this.searchAnchors.length); r++) {
			visible.add(r);
		}
		if (this.hoverPromotedRank !== null && !visible.has(this.hoverPromotedRank)) {
			// Drop the lowest-ranked default-expanded anchor to make room.
			let lowestRank = -1;
			for (const r of visible) if (r > lowestRank) lowestRank = r;
			if (lowestRank >= 0) visible.delete(lowestRank);
			visible.add(this.hoverPromotedRank);
		}

		for (const anchor of this.searchAnchors) {
			const isExpanded = visible.has(anchor.rank);
			anchor.expanded = isExpanded;
			anchor.card.toggleClass("is-visible", isExpanded);
			// The hovered dot stays visible; otherwise dots are always shown
			// because they double as the anchor pin even for expanded cards.
			anchor.dot.toggleClass("is-promoted", anchor.rank === this.hoverPromotedRank);

			if (isExpanded && !anchor.line) {
				const line = document.createElementNS(SVG_NS, "line") as SVGLineElement;
				line.setAttribute("class", "neuro-search-preview-line is-entering");
				linesSvg.appendChild(line);
				anchor.line = line;
			} else if (!isExpanded && anchor.line) {
				anchor.line.remove();
				anchor.line = null;
			}
		}
		this.repositionSearchOverlay();
	}

	/** Project each anchor's viewBox-space coordinates to overlay-relative
	 *  pixels via the rotator's screen CTM (which composes both the SVG
	 *  viewBox transform and the rotator's rotate()). Cards are pushed
	 *  outward from the SVG centre so they don't cover the brain region
	 *  they describe; leader lines connect dot → card edge. */
	private repositionSearchOverlay(): void {
		const svg     = this.svg;
		const wrap    = this.svgWrap;
		const rotator = this.rotatorGroup;
		const linesSvg = this.searchLinesEl;
		if (!svg || !wrap || !rotator || this.searchAnchors.length === 0) return;
		const ctm = rotator.getScreenCTM();
		if (!ctm) return;

		const wrapBox = wrap.getBoundingClientRect();
		// Outward direction = anchor − centre, in screen-space pixels. The
		// centre is the SVG's screen-projected centre, not the wrap centre,
		// so the offset stays sensible if the SVG doesn't fill the wrap.
		const svgBox = svg.getBoundingClientRect();
		const cx = svgBox.left + svgBox.width  / 2 - wrapBox.left;
		const cy = svgBox.top  + svgBox.height / 2 - wrapBox.top;

		if (linesSvg) {
			linesSvg.setAttribute("width",  String(wrapBox.width));
			linesSvg.setAttribute("height", String(wrapBox.height));
		}

		// First pass: project each anchor and record its natural outward angle.
		interface Placement {
			anchor:   SearchAnchor;
			ax:       number; ay: number;
			baseAngle:number;
			cardX:    number; cardY: number;
			halfW:    number; halfH: number;
		}
		const placements: Placement[] = [];
		const pt = svg.createSVGPoint();
		for (const anchor of this.searchAnchors) {
			pt.x = anchor.x;
			pt.y = anchor.y;
			const screen = pt.matrixTransform(ctm);
			const ax = screen.x - wrapBox.left;
			const ay = screen.y - wrapBox.top;
			anchor.dot.style.left = `${ax}px`;
			anchor.dot.style.top  = `${ay}px`;

			const baseAngle = Math.atan2(ay - cy, ax - cx);

			placements.push({
				anchor,
				ax, ay,
				baseAngle,
				cardX: ax + Math.cos(baseAngle) * CARD_OUTWARD_OFFSET_PX,
				cardY: ay + Math.sin(baseAngle) * CARD_OUTWARD_OFFSET_PX,
				halfW: anchor.card.offsetWidth  / 2,
				halfH: anchor.card.offsetHeight / 2,
			});
		}

		// Second pass: place each visible card. Search over (angle deviation,
		// distance) starting from the natural angle and the mandatory minimum
		// distance — pick the closest fit that stays inside the canvas and
		// doesn't overlap a previously placed card. Distance never drops below
		// CARD_OUTWARD_OFFSET_PX, so the dot→card gap is preserved.
		const expanded = placements.filter(p => p.anchor.expanded);
		expanded.sort((a, b) => a.anchor.rank - b.anchor.rank);
		const placed: Placement[] = [];
		const angleDeltas: number[] = [0];
		for (let s = 1; s <= 12; s++) {
			const rad = (s * 15) * Math.PI / 180;
			angleDeltas.push(rad);
			angleDeltas.push(-rad);
		}
		for (const p of expanded) {
			let placedOk = false;
			outer: for (let push = 0; push < CARD_PUSH_MAX_ITER; push++) {
				const distance = CARD_OUTWARD_OFFSET_PX + push * CARD_PUSH_STEP_PX;
				for (const delta of angleDeltas) {
					const a = p.baseAngle + delta;
					const cx2 = p.ax + Math.cos(a) * distance;
					const cy2 = p.ay + Math.sin(a) * distance;
					if (cx2 - p.halfW - CARD_EDGE_PAD_PX < 0) continue;
					if (cx2 + p.halfW + CARD_EDGE_PAD_PX > wrapBox.width)  continue;
					if (cy2 - p.halfH - CARD_EDGE_PAD_PX < 0) continue;
					if (cy2 + p.halfH + CARD_EDGE_PAD_PX > wrapBox.height) continue;
					let collided = false;
					for (const q of placed) {
						if (
							Math.abs(cx2 - q.cardX) < p.halfW + q.halfW + CARD_OVERLAP_PAD_PX &&
							Math.abs(cy2 - q.cardY) < p.halfH + q.halfH + CARD_OVERLAP_PAD_PX
						) { collided = true; break; }
					}
					if (collided) continue;
					p.cardX = cx2;
					p.cardY = cy2;
					placedOk = true;
					break outer;
				}
			}
			if (!placedOk) {
				// Fallback only when no on-canvas / non-overlapping pose exists
				// (very small viewport). Clamp to keep the card visible.
				const minX = p.halfW + CARD_EDGE_PAD_PX;
				const maxX = wrapBox.width  - p.halfW - CARD_EDGE_PAD_PX;
				const minY = p.halfH + CARD_EDGE_PAD_PX;
				const maxY = wrapBox.height - p.halfH - CARD_EDGE_PAD_PX;
				if (maxX > minX) p.cardX = Math.min(Math.max(p.cardX, minX), maxX);
				if (maxY > minY) p.cardY = Math.min(Math.max(p.cardY, minY), maxY);
			}
			placed.push(p);
		}

		// Third pass: write final positions for all placements (including
		// non-expanded anchors, which still have a default cardX/cardY).
		for (const p of placements) {
			p.anchor.card.style.left = `${p.cardX}px`;
			p.anchor.card.style.top  = `${p.cardY}px`;
			if (p.anchor.line) {
				p.anchor.line.setAttribute("x1", String(p.ax));
				p.anchor.line.setAttribute("y1", String(p.ay));
				p.anchor.line.setAttribute("x2", String(p.cardX));
				p.anchor.line.setAttribute("y2", String(p.cardY));
			}
		}
	}

	/** Wires reposition triggers: pan/zoom mutates the SVG viewBox attribute,
	 *  rotation mutates the rotator's transform, and layout changes (resize)
	 *  shift everything. Each fires repositionSearchOverlay. */
	private installOverlayObservers(): void {
		const svg     = this.svg;
		const wrap    = this.svgWrap;
		const rotator = this.rotatorGroup;
		if (!svg || !wrap || !rotator) return;

		this.viewBoxObserver?.disconnect();
		this.rotatorObserver?.disconnect();
		this.overlayResizeObserver?.disconnect();

		const reposition = () => this.repositionSearchOverlay();
		this.viewBoxObserver = new MutationObserver(reposition);
		this.viewBoxObserver.observe(svg, { attributes: true, attributeFilter: ["viewBox"] });
		this.rotatorObserver = new MutationObserver(reposition);
		this.rotatorObserver.observe(rotator, { attributes: true, attributeFilter: ["transform"] });
		this.overlayResizeObserver = new ResizeObserver(reposition);
		this.overlayResizeObserver.observe(wrap);
	}

	private teardownOverlayObservers(): void {
		this.viewBoxObserver?.disconnect();
		this.rotatorObserver?.disconnect();
		this.overlayResizeObserver?.disconnect();
		this.viewBoxObserver = null;
		this.rotatorObserver = null;
		this.overlayResizeObserver = null;
	}

	private viewpointKey(): string { return this.opts.file.basename; }

	/** Folder where new cells for this viewpoint are written, and the only
	 *  folder existing cells are queried from. Keeps each viewpoint's roster
	 *  isolated from other viewpoints (and from the global cells folder). */
	private cellsFolder(): string { return cellsFolderForViewpoint(this.opts.file); }

	private cellsForLayer(acronym: string): TFile[] {
		return getCellTypesForLayer(this.opts.app, acronym, this.cellsFolder());
	}

	/** Hooks up click-to-drill-into-cell on a cell's sub-group.
	 *  Tracks pointerdown coords so a pan-zoom drag does not fire a click. */
	private attachCellClickHandler(group: SVGGElement, file: TFile): void {
		let downX = 0, downY = 0, moved = false;
		group.addEventListener("pointerdown", evt => {
			downX = evt.clientX;
			downY = evt.clientY;
			moved = false;
		});
		group.addEventListener("pointermove", evt => {
			if (Math.hypot(evt.clientX - downX, evt.clientY - downY) > 4) moved = true;
		});
		group.addEventListener("click", evt => {
			if (this.placement !== null) return;       // placement mode owns clicks
			if (moved) return;                          // was a drag, not a click
			evt.stopPropagation();
			this.opts.onOpenCell?.(file);
		});
	}

	// ── Navigator sections (rendered by host into combined navigator) ────────

	/** Called by MapTheMindView from rebuildNavigator() after the region-notes
	 *  block. We append our subregions table, optional focused-layer section,
	 *  and (when in placement mode) the placement controls. */
	renderNavigatorSections(container: HTMLElement): void {
		if (this.placement) {
			this.renderPlacementSection(container);
			return;
		}
		this.renderSubregionsSection(container);
		if (this.focusedLayerId !== null) {
			this.renderFocusedLayerSection(container);
		}
	}

	private renderSubregionsSection(panel: HTMLElement): void {
		const section = panel.createEl("details", { cls: "neuro-side-section" });
		section.setAttr("open", "true");
		const head = section.createEl("summary", { cls: "neuro-side-section-head" });
		head.createSpan({ text: "Subregions" });

		// Per-subregion rows: name + cell count badge + nested cell checkboxes.
		const list = section.createDiv({ cls: "neuro-subregion-list" });
		let totalCells = 0;
		for (const layer of this.layers) {
			const files = this.cellsForLayer(layer.acronym);
			totalCells += files.length;
			if (files.length === 0) continue;

			const row = list.createDiv({ cls: "neuro-subregion-row" });
			const heading = row.createDiv({ cls: "neuro-subregion-row-head" });
			heading.createSpan({
				text: `${layer.acronym} — ${layer.name}`,
				cls:  "neuro-subregion-row-title",
			});
			heading.createSpan({
				text: `${files.length}`,
				cls:  "neuro-subregion-row-count",
			});

			const cellsList = row.createDiv({ cls: "neuro-subregion-cells" });
			for (const file of files) {
				const fm = this.opts.app.metadataCache.getFileCache(file)?.frontmatter as
					Partial<CellTypeFrontmatter> | undefined;
				const cellRow = cellsList.createDiv({ cls: "neuro-subregion-cell-row" });

				const cb = cellRow.createEl("input", {
					type: "checkbox",
					cls:  "neuro-subregion-cell-toggle",
				}) as HTMLInputElement;
				cb.checked = !this.hiddenCells.has(file.path);
				cb.addEventListener("change", () => {
					if (cb.checked) this.hiddenCells.delete(file.path);
					else            this.hiddenCells.add(file.path);
					this.renderCellOverlay();
				});

				const label = cellRow.createSpan({
					text: fm?.cell_name ?? file.basename,
					cls:  "neuro-subregion-cell-label",
				});
				label.addEventListener("click", () =>
					void this.opts.app.workspace.getLeaf().openFile(file),
				);

				const editBtn = cellRow.createEl("button", {
					text: "✎",
					cls:  "neuro-subregion-cell-edit-btn",
					attr: { title: "Edit placement in this viewpoint" },
				});
				editBtn.addEventListener("click", evt => {
					evt.stopPropagation();
					this.beginPlacement({ mode: "edit", file, leafLayer: layer });
				});

				const drillBtn = cellRow.createEl("button", {
					text: "→",
					cls:  "neuro-subregion-cell-drill-btn",
					attr: { title: "Open cell view", "aria-label": "Open cell view" },
				});
				drillBtn.addEventListener("click", evt => {
					evt.stopPropagation();
					this.opts.onOpenCell?.(file);
				});
			}
		}

		if (totalCells === 0) {
			section.createEl("p", {
				text: "Click a subregion below to add a cell — it will appear here.",
				cls:  "neuro-cell-view-empty",
			});
		}

		// Compartment toggles apply globally to all rendered morphologies.
		const anyMorph = this.layers.some(layer =>
			this.cellsForLayer(layer.acronym).some(f => {
				const fm = this.opts.app.metadataCache.getFileCache(f)?.frontmatter as
					Partial<CellTypeFrontmatter> | undefined;
				return !!fm?.morphology_source && !this.hiddenCells.has(f.path);
			}));
		if (anyMorph) this.renderCompartmentToggles(section);
	}

	private renderFocusedLayerSection(panel: HTMLElement): void {
		const layer = this.layers.find(l => l.id === this.focusedLayerId);
		if (!layer) return;

		const section = panel.createEl("details", { cls: "neuro-side-section" });
		section.setAttr("open", "true");
		const head = section.createEl("summary", { cls: "neuro-side-section-head" });
		head.createSpan({ text: `Selected: ${layer.acronym}` });

		section.createEl("div", { text: layer.name, cls: "neuro-cell-view-list-meta" });

		const addBtn = section.createEl("button", {
			text: "+ Add cell",
			cls:  "mod-cta neuro-cell-view-add-btn",
		});
		addBtn.addEventListener("click", () => {
			const siblings = this.layers.map(l => l.acronym);
			this.opts.onCreateCell(layer, siblings);
		});

		const clearBtn = section.createEl("button", {
			text: "Clear selection",
			cls:  "neuro-viewpoint-deselect-btn-text",
		});
		clearBtn.addEventListener("click", () => {
			this.focusedLayerId = null;
			this.applyLayerClasses();
			this.opts.onRequestNavRebuild?.();
		});
	}

	private renderCompartmentToggles(panel: HTMLElement): void {
		const row = panel.createDiv({ cls: "neuro-compartment-toggles" });
		row.createEl("span", { text: "Show:", cls: "neuro-compartment-toggles-label" });
		const options: Array<{ key: Compartment; label: string }> = [
			{ key: "soma",     label: "Soma" },
			{ key: "dendrite", label: "Dendrite" },
			{ key: "axon",     label: "Axon" },
		];
		for (const { key, label } of options) {
			const btn = row.createEl("button", {
				text: label,
				cls:  "neuro-compartment-toggle",
			});
			if (this.visibleCompartments.has(key)) btn.addClass("is-active");
			btn.addEventListener("click", () => {
				if (this.visibleCompartments.has(key)) {
					this.visibleCompartments.delete(key);
				} else {
					this.visibleCompartments.add(key);
				}
				btn.toggleClass("is-active", this.visibleCompartments.has(key));
				this.renderCellOverlay();
			});
		}
	}

	// ── Placement mode ────────────────────────────────────────────────────────

	/** Public entry point — invoked from MapTheMindView after AddCellModal picks
	 *  a candidate, or from the per-cell pencil button to edit an existing
	 *  placement. Sets up the session, fetches the SWC if needed, then renders. */
	async beginPlacement(seed: PlacementSeed): Promise<void> {
		const layer = seed.leafLayer;
		const layerCentroid = this.centroids.get(layer.acronym.toLowerCase());
		if (!layerCentroid) {
			new Notice(`No centroid for ${layer.acronym} — cannot place a cell here.`);
			return;
		}

		const session: PlacementSession = {
			mode:        seed.mode,
			leafLayer:   layer,
			leafCentroid: layerCentroid,
			placement:   { x: layerCentroid.cx, y: layerCentroid.cy, scale: 1, rotation: 0 },
			cellName:    "",
			cellClass:   "pyramidal",
			dragging:    false,
		};

		if (seed.mode === "create" && "candidate" in seed) {
			session.candidate  = seed.candidate;
			session.cellName   = seed.candidate.name;
			session.cellClass  = inferCellClass(seed.candidate.cellType) ?? "pyramidal";
			session.morphIdent = seed.candidate.identifier;
		} else if (seed.mode === "create" && "schematic" in seed) {
			session.schematic = true;
			session.cellName  = `${layer.acronym} cell`;
		} else if (seed.mode === "edit") {
			session.file = seed.file;
			const fm = this.opts.app.metadataCache.getFileCache(seed.file)?.frontmatter as
				Partial<CellTypeFrontmatter> | undefined;
			session.cellName  = fm?.cell_name ?? seed.file.basename;
			session.cellClass = (fm?.cell_class as CellClass) ?? "pyramidal";
			session.morphIdent = fm?.morphology_source;
			const stored = fm?.placements?.[this.viewpointKey()];
			if (stored) session.placement = { ...stored };
		}

		this.placement = session;

		// Pre-fetch SWC so live drag stays synchronous.
		if (session.morphIdent) {
			try {
				session.swcNodes = await fetchNeuronSwc(session.morphIdent, this.opts.app.vault.adapter);
			} catch (err) {
				console.warn("[neuro-mindmap] placement SWC fetch failed:", err);
			}
		}

		this.attachPlacementHandlers();
		this.opts.onRequestNavRebuild?.();
		this.renderCellOverlay();
	}

	private cancelPlacement(): void {
		this.placement = null;
		this.placementSectionEl = null;
		this.detachPlacementHandlers();
		this.opts.onRequestNavRebuild?.();
		this.renderCellOverlay();
	}

	private async savePlacement(): Promise<void> {
		const s = this.placement;
		if (!s) return;
		const vpKey = this.viewpointKey();

		try {
			if (s.mode === "edit" && s.file) {
				await this.opts.app.fileManager.processFrontMatter(s.file, fm => {
					const existing = (fm.placements ?? {}) as Record<string, Placement>;
					existing[vpKey] = { ...s.placement };
					fm.placements   = existing;
					fm.cell_name    = s.cellName;
				});
				new Notice("Placement saved.");
			} else {
				const folderPath = this.cellsFolder();
				if (!this.opts.app.vault.getFolderByPath(folderPath)) {
					await this.opts.app.vault.createFolder(folderPath);
				}
				const slug     = uniqueCellSlug(this.opts.app, folderPath, slugify(s.cellName));
				const filePath = `${folderPath}/${slug}.md`;

				const fm: CellTypeFrontmatter = {
					entity_type: "cell-type",
					tags: ["cell-type"],
					cell_name:   s.cellName,
					cell_class:  s.cellClass,
					brain_region: s.leafLayer.acronym,
					layer_id:    s.leafLayer.acronym,
					placements:  { [vpKey]: { ...s.placement } },
				};
				if (s.morphIdent) fm.morphology_source = s.morphIdent;

				const body = `---\n${stringifyYaml(fm)}---\n\n# ${s.cellName}\n`;
				await this.opts.app.vault.create(filePath, body);
				new Notice(`Created ${slug}.md`);
			}
		} catch (err) {
			new Notice(`Save failed: ${(err as Error).message}`);
			return;
		}

		this.placement = null;
		this.placementSectionEl = null;
		this.detachPlacementHandlers();
		this.opts.onRequestNavRebuild?.();
		this.renderCellOverlay();
	}

	private renderPlacementSection(panel: HTMLElement): void {
		const s = this.placement;
		if (!s) return;
		const section = panel.createEl("details", { cls: "neuro-side-section" });
		section.setAttr("open", "true");
		const head = section.createEl("summary", { cls: "neuro-side-section-head" });
		head.createSpan({
			text: s.mode === "edit" ? "Editing placement" : "Placing cell",
		});

		this.placementSectionEl = section;

		const wrap = section.createDiv({ cls: "neuro-placement-controls" });

		const nameRow = wrap.createDiv({ cls: "neuro-placement-row" });
		nameRow.createSpan({ text: "Name" });
		const nameInput = nameRow.createEl("input", { type: "text" }) as HTMLInputElement;
		nameInput.value = s.cellName;
		nameInput.addEventListener("input", () => { s.cellName = nameInput.value; });

		if (s.mode === "create" && s.schematic) {
			const classRow = wrap.createDiv({ cls: "neuro-placement-row" });
			classRow.createSpan({ text: "Class" });
			const sel = classRow.createEl("select") as HTMLSelectElement;
			for (const v of ["pyramidal","interneuron","granule","glial","other"] as CellClass[]) {
				const opt = sel.createEl("option", { text: v, value: v });
				if (v === s.cellClass) opt.selected = true;
			}
			sel.addEventListener("change", () => {
				s.cellClass = sel.value as CellClass;
				this.renderPlacementPreview();
			});
		}

		const numRow = (label: string, get: () => number, set: (v: number) => void, step: number): void => {
			const row = wrap.createDiv({ cls: "neuro-placement-row" });
			row.createSpan({ text: label });
			const inp = row.createEl("input", { type: "number" }) as HTMLInputElement;
			inp.step  = step.toString();
			inp.value = get().toFixed(1);
			inp.addEventListener("input", () => {
				const v = parseFloat(inp.value);
				if (!Number.isFinite(v)) return;
				set(v);
				this.renderPlacementPreview();
			});
		};

		const sliderRow = (
			label: string,
			get:   () => number,
			set:   (v: number) => void,
			min:   number,
			max:   number,
			step:  number,
		): void => {
			const row = wrap.createDiv({ cls: "neuro-placement-row" });
			row.createSpan({ text: label });
			const slider = row.createEl("input", { type: "range" }) as HTMLInputElement;
			slider.min   = min.toString();
			slider.max   = max.toString();
			slider.step  = step.toString();
			slider.value = get().toString();
			const readout = row.createSpan({ cls: "neuro-placement-readout" });
			readout.setText(get().toFixed(2));
			slider.addEventListener("input", () => {
				const v = parseFloat(slider.value);
				if (!Number.isFinite(v)) return;
				set(v);
				readout.setText(v.toFixed(2));
				this.renderPlacementPreview();
			});
		};

		numRow("x",         () => s.placement.x,        v => { s.placement.x = v; }, this.viewBoxSide / 100);
		numRow("y",         () => s.placement.y,        v => { s.placement.y = v; }, this.viewBoxSide / 100);
		sliderRow("scale",  () => s.placement.scale,    v => { s.placement.scale = v; },   0.1, 5,   0.05);
		sliderRow("rotate", () => s.placement.rotation, v => { s.placement.rotation = v; }, -180, 180, 1);

		const help = wrap.createDiv({ cls: "neuro-placement-help" });
		help.setText("Drag the preview to move · use sliders for scale and rotation · arrows nudge · Esc cancels.");

		const btnRow = wrap.createDiv({ cls: "neuro-placement-buttons" });
		const saveBtn = btnRow.createEl("button", { text: "Save", cls: "mod-cta" });
		saveBtn.addEventListener("click", () => void this.savePlacement());
		const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.cancelPlacement());
	}

	private renderPlacementPreview(): void {
		const group = this.previewGroup;
		if (!group) return;
		group.empty();
		const s = this.placement;
		if (!s) return;

		const focus = s.leafCentroid;
		const fm: Partial<CellTypeFrontmatter> = {
			cell_class:        s.cellClass,
			cell_name:         s.cellName,
			brain_region:      s.leafLayer.acronym,
			morphology_source: s.morphIdent,
		};

		if (s.swcNodes && s.morphIdent) {
			drawMorphologyNodes(group, focus, fm, this.plane, s.swcNodes, {
				compartments: this.visibleCompartments,
				placement:    {
					cx:       s.placement.x,
					cy:       s.placement.y,
					scale:    s.placement.scale,
					rotation: s.placement.rotation,
				},
			});
		} else {
			drawCellGlyph(group, focus, fm, this.centroids,
				{ placement: { cx: s.placement.x, cy: s.placement.y } });
		}

		this.refreshPlacementInputs();
	}

	private refreshPlacementInputs(): void {
		const s = this.placement;
		const panel = this.placementSectionEl;
		if (!s || !panel) return;
		const numbers = panel.querySelectorAll<HTMLInputElement>(".neuro-placement-row input[type=\"number\"]");
		// Order matches numRow calls in renderPlacementSection: x, y.
		const numValues = [s.placement.x, s.placement.y];
		numbers.forEach((inp, i) => {
			const v = numValues[i];
			if (v !== undefined && document.activeElement !== inp) {
				inp.value = v.toFixed(1);
			}
		});
		const sliders = panel.querySelectorAll<HTMLInputElement>(".neuro-placement-row input[type=\"range\"]");
		// Order matches sliderRow calls: scale, rotate.
		const sliderValues = [s.placement.scale, s.placement.rotation];
		sliders.forEach((inp, i) => {
			const v = sliderValues[i];
			if (v === undefined) return;
			if (document.activeElement !== inp) inp.value = v.toString();
			const readout = inp.nextElementSibling as HTMLElement | null;
			if (readout?.classList.contains("neuro-placement-readout")) {
				readout.setText(v.toFixed(2));
			}
		});
	}

	private onPlacementPointerDown = (evt: PointerEvent): void => {
		const s = this.placement;
		const svg = this.svg;
		if (!s || !svg || evt.button !== 0) return;
		// Use the rotator's CTM so the pointer→viewBox conversion accounts
		// for the active view rotation; otherwise dragging after a rotation
		// moves the cell along the wrong axis.
		const pt = svgPoint(this.rotatorGroup ?? svg, evt.clientX, evt.clientY);
		if (!pt) return;
		s.dragging = true;
		s.dragLast = pt;
		evt.stopPropagation();
		evt.preventDefault();
		// Capture on the preview group, not evt.target — renderPlacementPreview()
		// rebuilds the group's children every move, and setPointerCapture is
		// implicitly released when the captured element is detached from the DOM.
		this.previewGroup?.setPointerCapture?.(evt.pointerId);
	};
	private onPlacementPointerMove = (evt: PointerEvent): void => {
		const s = this.placement;
		const svg = this.svg;
		if (!s || !svg || !s.dragging || !s.dragLast) return;
		const pt = svgPoint(this.rotatorGroup ?? svg, evt.clientX, evt.clientY);
		if (!pt) return;
		s.placement.x += pt.x - s.dragLast.x;
		s.placement.y += pt.y - s.dragLast.y;
		s.dragLast = pt;
		this.renderPlacementPreview();
	};
	private onPlacementPointerUp = (evt: PointerEvent): void => {
		const s = this.placement;
		if (!s || !s.dragging) return;
		s.dragging = false;
		s.dragLast = undefined;
		this.previewGroup?.releasePointerCapture?.(evt.pointerId);
	};
	private attachPlacementHandlers(): void {
		const group = this.previewGroup;
		if (!group) return;
		group.addEventListener("pointerdown", this.onPlacementPointerDown);
		group.addEventListener("pointermove", this.onPlacementPointerMove);
		group.addEventListener("pointerup",   this.onPlacementPointerUp);

		const handler = (evt: KeyboardEvent): void => {
			const s = this.placement;
			if (!s) return;
			const nudge = this.viewBoxSide * 0.01;
			switch (evt.key) {
				case "ArrowLeft":  s.placement.x -= nudge; break;
				case "ArrowRight": s.placement.x += nudge; break;
				case "ArrowUp":    s.placement.y -= nudge; break;
				case "ArrowDown":  s.placement.y += nudge; break;
				case "r":          s.placement.rotation += 5; break;
				case "R":          s.placement.rotation -= 5; break;
				case "+": case "=": s.placement.scale = Math.min(10, s.placement.scale * 1.1); break;
				case "-": case "_": s.placement.scale = Math.max(0.1, s.placement.scale / 1.1); break;
				case "Escape":     this.cancelPlacement(); return;
				default: return;
			}
			evt.preventDefault();
			this.renderPlacementPreview();
		};
		this.placementKeyHandler = handler;
		document.addEventListener("keydown", handler);
	}

	private detachPlacementHandlers(): void {
		const group = this.previewGroup;
		if (group) {
			group.removeEventListener("pointerdown", this.onPlacementPointerDown);
			group.removeEventListener("pointermove", this.onPlacementPointerMove);
			group.removeEventListener("pointerup",   this.onPlacementPointerUp);
		}
		if (this.placementKeyHandler) {
			document.removeEventListener("keydown", this.placementKeyHandler);
			this.placementKeyHandler = null;
		}
	}
}

/** Pulls the YAML frontmatter block out of a markdown file's raw contents
 *  and parses it. Used as a fallback when metadataCache hasn't indexed a
 *  just-created note yet (race right after `vault.create`). */
function parseFrontmatterFromContent(content: string): Partial<ViewpointFrontmatter> | undefined {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match || !match[1]) return undefined;
	try {
		return parseYaml(match[1]) as Partial<ViewpointFrontmatter>;
	} catch {
		return undefined;
	}
}

function svgPoint(
	target:  SVGGraphicsElement,
	clientX: number,
	clientY: number,
): { x: number; y: number } | null {
	const ctm = target.getScreenCTM();
	if (!ctm) return null;
	const owner = target.ownerSVGElement ?? (target as unknown as SVGSVGElement);
	const pt = owner.createSVGPoint();
	pt.x = clientX; pt.y = clientY;
	const t = pt.matrixTransform(ctm.inverse());
	return { x: t.x, y: t.y };
}

function inferCellClass(cellType: string | undefined): CellClass | null {
	if (!cellType) return null;
	const s = cellType.toLowerCase();
	if (s.includes("pyramidal"))                       return "pyramidal";
	if (s.includes("granule"))                         return "granule";
	if (s.includes("interneuron") || s.includes("basket") ||
		s.includes("parvalbumin")  || s.includes("chandelier")) return "interneuron";
	if (s.includes("astrocyte")    || s.includes("glia") ||
		s.includes("microglia"))                        return "glial";
	return null;
}

function uniqueCellSlug(app: import("obsidian").App, folder: string, base: string): string {
	let slug = base || "cell";
	let n = 2;
	while (app.vault.getAbstractFileByPath(`${folder}/${slug}.md`)) {
		slug = `${base}-${n}`;
		n++;
	}
	return slug;
}

function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function parseViewBox(raw: string): { x: number; y: number; w: number; h: number } {
	const parts = raw.trim().split(/\s+/).map(Number);
	if (parts.length !== 4 || parts.some(v => !Number.isFinite(v))) {
		return { x: 0, y: 0, w: 1000, h: 1000 };
	}
	return { x: parts[0]!, y: parts[1]!, w: parts[2]!, h: parts[3]! };
}

/**
 * Heuristic match for "this subregion is predominantly cell bodies", based on
 * Allen structure names. Covers pyramidal / granule / Purkinje / mitral layers
 * and the common hippocampal `stratum ...` names.
 */
function isCellDenseLayer(name: string): boolean {
	const n = name.toLowerCase();
	return (
		n.includes("pyramidal layer") ||
		n.includes("pyramidal cell layer") ||
		n.includes("granule cell layer") ||
		n.includes("granular layer") ||
		n.includes("granule layer") ||
		n.includes("purkinje") ||
		n.includes("mitral") ||
		n.includes("stratum pyramidale") ||
		n.includes("stratum granulosum")
	);
}
