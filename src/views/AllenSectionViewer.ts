// ──────────────────────────────────────────────────────────────────────────────
// views/AllenSectionViewer.ts  —  Allen CCFv3 section viewer.
//
// Displays the anatomically accurate Allen Brain Atlas SVG annotation for a
// chosen brain structure, clipped and zoomed to that structure's bounds.
// Child structures (sub-regions / layers) appear as distinct coloured regions.
// Cell body dots from vault notes are overlaid at sub-region centroids.
// ──────────────────────────────────────────────────────────────────────────────

import type { App, TFile } from "obsidian";
import { Notice } from "obsidian";
import type { AllenStructureFlat } from "../api/allenStructureCache";
import { getChildren, getDescendantIds } from "../api/allenStructureCache";
import {
	findSectionsForStructure,
	type AllenAtlasSection,
} from "../api/allenAtlas2D";
import type { AtlasProvider } from "../atlas";
import type { CellClass, ConnectionDirection } from "../types";
import { HelpModal } from "../HelpModal";

const SVG_NS = "http://www.w3.org/2000/svg";

// ── Public types ───────────────────────────────────────────────────────────────

export interface ActiveCellNote {
	/** Allen structure ID (as string) or legacy slug. */
	layerId:   string;
	cellClass: CellClass;
	file:      TFile;
}

export interface ActiveConnection {
	sourceLayerId: string;
	targetLayerId: string;
	label?:        string;
	style:         "wikilink" | "explicit";
	direction:     ConnectionDirection;
}

export interface AllenSectionViewerOptions {
	app:          App;
	/** Atlas provider — used for section lists, SVG fetches, and the
	 *  atlas-cache directory. */
	provider:     AtlasProvider;
	allenId:      number;
	sectionType:  "coronal" | "sagittal";
	structureTree: Map<number, AllenStructureFlat>;
	activeCellNotes?:   ActiveCellNote[];
	activeConnections?: ActiveConnection[];
	onDotClick?: (childAllenId: number, file: TFile | null) => void;
	/**
	 * When provided, a "Use this slice" button appears next to the slider.
	 * Clicking it invokes this callback with the currently-rendered SVG and
	 * section metadata. The callback is responsible for extracting polygons
	 * and persisting the viewpoint — the viewer stays agnostic of that flow.
	 *
	 * Setting this also switches the viewer to "picker mode": only the target
	 * structure is coloured, every other structure is rendered in a neutral
	 * grey so the user can clearly see what they're about to capture.
	 */
	onSliceSelected?: (svgEl: SVGSVGElement, section: AllenAtlasSection) => void;
}

// ── Color mapping ──────────────────────────────────────────────────────────────

const CELL_CLASS_COLORS: Record<string, string> = {
	pyramidal:   "#e07b3a",
	interneuron: "#4a90d9",
	granule:     "#7bc67e",
	glial:       "#b28fce",
	other:       "#aaaaaa",
};

// ── Viewer ────────────────────────────────────────────────────────────────────

export class AllenSectionViewer {
	private opts:      AllenSectionViewerOptions;
	private container: HTMLElement | null = null;
	private sections:  AllenAtlasSection[] = [];
	private sectionIndices: number[] = [];   // which sections contain this structure
	private currentIdx: number = 0;          // index into sectionIndices
	/** Target structure + all transitive descendants — any of these will match SVG paths. */
	private descendantIds: Set<number>;
	/** Most recently rendered display SVG — used by the "Use this slice" callback. */
	private currentSvg: SVGSVGElement | null = null;
	/** Section corresponding to `currentSvg`. */
	private currentSection: AllenAtlasSection | null = null;

	constructor(opts: AllenSectionViewerOptions) {
		this.opts = opts;
		this.descendantIds = getDescendantIds(opts.allenId, opts.structureTree);
	}

	/** Renders into the given container element. Starts async load. */
	render(container: HTMLElement): void {
		this.container = container;
		container.empty();
		container.addClass("neuro-section-viewer");

		const header = container.createDiv({ cls: "neuro-section-header" });
		const node   = this.opts.structureTree.get(this.opts.allenId);
		header.createEl("span", {
			text: node ? `${node.name} [${node.acronym}]` : `Structure ${this.opts.allenId}`,
			cls: "neuro-section-title",
		});

		const helpBtn = header.createEl("button", {
			text: "?",
			cls:  "neuro-help-btn neuro-section-help-btn",
			attr: { title: "Help for the slice picker" },
		});
		helpBtn.addEventListener("click", () =>
			new HelpModal(this.opts.app, "slicePicker").open());

		const svgContainer = container.createDiv({ cls: "neuro-section-svg-wrap" });
		const sliderRow    = container.createDiv({ cls: "neuro-section-slider-row" });

		void this.loadAndRender(svgContainer, sliderRow);
	}

	// ── Loading ──────────────────────────────────────────────────────────────────

	private async loadAndRender(
		svgContainer: HTMLElement,
		sliderRow:    HTMLElement,
	): Promise<void> {
		const { app, provider, allenId, sectionType } = this.opts;
		const adapter  = app.vault.adapter;
		const cacheDir = provider.atlasCacheDir;

		svgContainer.createEl("p", { text: "Loading sections…", cls: "neuro-section-loading" });

		try {
			// 1. Fetch full section list
			this.sections = await provider.listSections(sectionType);

			// 2. Pre-fetch a window of SVGs around the midpoint so the index scan works
			const mid = Math.floor(this.sections.length / 2);
			const window = 20;
			await this.prefetchSvgWindow(mid - window, mid + window);

			// 3. Find which sections contain this structure (any descendant leaf).
			this.sectionIndices = await findSectionsForStructure(
				allenId, sectionType, this.sections, cacheDir, adapter, this.descendantIds,
			);

			// If we found nothing in the cached window, widen to the full atlas.
			if (this.sectionIndices.length === 0) {
				await this.prefetchSvgWindow(0, this.sections.length);
				this.sectionIndices = await findSectionsForStructure(
					allenId, sectionType, this.sections, cacheDir, adapter, this.descendantIds,
				);
			}

			if (this.sectionIndices.length === 0) {
				svgContainer.empty();
				svgContainer.createEl("p", {
					text: "No sections found for this structure. The structure may be absent from the 2D atlas at this resolution.",
					cls: "neuro-section-empty",
				});
				return;
			}

			// Start at the middle matching section
			this.currentIdx = Math.floor(this.sectionIndices.length / 2);
			this.buildSlider(sliderRow);
			await this.renderSection(svgContainer);

		} catch (err) {
			svgContainer.empty();
			svgContainer.createEl("p", {
				text: `Failed to load sections: ${(err as Error).message}`,
				cls: "neuro-section-error",
			});
			new Notice("[neuro-mindmap] Section load failed — check network.");
		}
	}

	private async prefetchSvgWindow(from: number, to: number): Promise<void> {
		const { app, provider } = this.opts;
		const adapter = app.vault.adapter;
		const cacheDir = provider.atlasCacheDir;
		const start = Math.max(0, from);
		const end   = Math.min(this.sections.length - 1, to);
		const tasks: Promise<void>[] = [];
		for (let i = start; i <= end; i++) {
			const section = this.sections[i];
			if (!section) continue;
			const svgPath = `${cacheDir}/svg/${section.id}.svg`;
			if (!(await adapter.exists(svgPath))) {
				tasks.push(
					provider.fetchSectionSvg(section.id).then(() => undefined).catch(() => undefined)
				);
			}
		}
		await Promise.all(tasks);
	}

	// ── Rendering ────────────────────────────────────────────────────────────────

	private async renderSection(svgContainer: HTMLElement): Promise<void> {
		svgContainer.empty();

		const sectionArrayIdx = this.sectionIndices[this.currentIdx];
		if (sectionArrayIdx === undefined) return;
		const section = this.sections[sectionArrayIdx];
		if (!section) return;

		const { provider, allenId, structureTree } = this.opts;
		const svgText = await provider.fetchSectionSvg(section.id);

		// Parse SVG
		const parser = new DOMParser();
		const doc    = parser.parseFromString(svgText, "image/svg+xml");
		const svgEl  = doc.querySelector("svg");
		if (!svgEl) {
			svgContainer.createEl("p", { text: "Invalid SVG data.", cls: "neuro-section-error" });
			return;
		}

		const isPicker  = !!this.opts.onSliceSelected;

		// ── Step 1: insert SVG into a hidden measuring element so getBBox
		// works on every annotated path. Allen SVGs only annotate leaf
		// structures, so a non-leaf target (CA1, Hippocampus, Isocortex, …)
		// matches via its descendants.
		const measurer = svgContainer.createDiv();
		measurer.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;width:1px;height:1px;overflow:hidden;";
		const svgClone = document.adoptNode(svgEl.cloneNode(true) as SVGSVGElement);
		measurer.appendChild(svgClone as Node);

		// ── Step 2: compute the target structure's clipBox = union bbox of
		// every descendant-leaf path.
		let clipBox: { x: number; y: number; width: number; height: number } | null = null;
		const annotated = (svgClone as Element).querySelectorAll("[structure_id]");
		for (const el of Array.from(annotated)) {
			const sidNum = parseInt(el.getAttribute("structure_id") ?? "", 10);
			if (!Number.isFinite(sidNum) || !this.descendantIds.has(sidNum)) continue;
			let b: DOMRect;
			try { b = (el as unknown as SVGGraphicsElement).getBBox(); } catch { continue; }
			if (b.width === 0 && b.height === 0) continue;
			if (!clipBox) {
				clipBox = { x: b.x, y: b.y, width: b.width, height: b.height };
			} else {
				const x1 = Math.min(clipBox.x, b.x);
				const y1 = Math.min(clipBox.y, b.y);
				const x2 = Math.max(clipBox.x + clipBox.width,  b.x + b.width);
				const y2 = Math.max(clipBox.y + clipBox.height, b.y + b.height);
				clipBox = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
			}
		}

		measurer.remove();

		// ── Step 3: build a fresh SVG for display ──────────────────────────────
		const displaySvg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
		displaySvg.setAttribute("xmlns", SVG_NS);
		displaySvg.style.cssText = "width:100%;height:100%;display:block;";

		// Copy all children from the parsed SVG
		const importedSvg = document.adoptNode(svgEl.cloneNode(true) as SVGSVGElement);
		const childNodes = Array.from((importedSvg as Element).childNodes);
		for (const child of childNodes) {
			displaySvg.appendChild(child);
		}

		// Apply clipped viewBox around the target structure (+40px padding)
		if (clipBox && clipBox.width > 0) {
			const pad = 40;
			const vb  = `${clipBox.x - pad} ${clipBox.y - pad} ${clipBox.width + pad * 2} ${clipBox.height + pad * 2}`;
			displaySvg.setAttribute("viewBox", vb);
		} else {
			const fallbackVb = (importedSvg as SVGSVGElement).getAttribute("viewBox");
			if (fallbackVb) displaySvg.setAttribute("viewBox", fallbackVb);
		}
		displaySvg.removeAttribute("width");
		displaySvg.removeAttribute("height");

		// ── Step 4: in picker mode, neutralise every non-target annotated
		// path so only the target structure carries colour. Outside picker
		// mode this step is skipped; the source Allen colours remain.
		if (isPicker) {
			for (const el of Array.from(displaySvg.querySelectorAll("[structure_id]"))) {
				const sidNum = parseInt(el.getAttribute("structure_id") ?? "", 10);
				if (Number.isFinite(sidNum) && this.descendantIds.has(sidNum)) continue;
				const p = el as SVGElement;
				p.style.fill        = "#e8e8e8";
				p.style.opacity     = "0.6";
				p.style.stroke      = "#bbbbbb";
				p.style.strokeWidth = "0.5";
			}
		}

		// ── Step 5: highlight every descendant-leaf path with the target color ─
		const node     = structureTree.get(allenId);
		const hexColor = node ? `#${node.color_hex_triplet}` : "#ff8800";
		for (const p of descendantPaths(displaySvg, this.descendantIds)) {
			p.style.fill        = hexColor;
			p.style.opacity     = "0.55";
			p.style.stroke      = hexColor;
			p.style.strokeWidth = "2";
		}

		// ── Step 6: outside picker mode, repaint each direct child's leaves
		// in the child's Allen colour so the sub-region partition is visible.
		// In picker mode we keep the target as a single solid colour.
		const children2 = getChildren(allenId, structureTree);
		if (!isPicker) {
			for (const child of children2) {
				const childDesc = getDescendantIds(child.id, structureTree);
				for (const p of descendantPaths(displaySvg, childDesc)) {
					p.style.fill        = `#${child.color_hex_triplet}`;
					p.style.opacity     = "0.7";
					p.style.stroke      = `#${child.color_hex_triplet}`;
					p.style.strokeWidth = "1";
				}
			}
		}

		svgContainer.appendChild(displaySvg);
		this.currentSvg     = displaySvg;
		this.currentSection = section;

		// ── Step 6: overlay dots and connection arrows ─────────────────────────
		this.overlayDots(svgContainer, displaySvg, children2);
	}

	// ── Dot overlay ──────────────────────────────────────────────────────────────

	private overlayDots(
		container:   HTMLElement,
		displaySvg:  SVGSVGElement,
		subRegions:  AllenStructureFlat[],
	): void {
		const { activeCellNotes = [], activeConnections = [], onDotClick } = this.opts;

		if (subRegions.length === 0) return;

		// Build overlay SVG (transparent, positioned over displaySvg)
		const overlaySvg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
		overlaySvg.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible;";
		const vb = displaySvg.getAttribute("viewBox");
		if (vb) overlaySvg.setAttribute("viewBox", vb);
		overlaySvg.removeAttribute("width");
		overlaySvg.removeAttribute("height");

		// Add connection arrow defs
		const defs = document.createElementNS(SVG_NS, "defs");
		defs.appendChild(buildArrowMarker("arrow-wiki",     "none",                         "rgba(150,150,150,0.6)", "1"));
		defs.appendChild(buildArrowMarker("arrow-explicit", "var(--interactive-accent)",    "none",                  null));
		overlaySvg.appendChild(defs);

		// Map childId → centroid in SVG coordinates
		const centroids = new Map<number, { x: number; y: number }>();

		for (const child of subRegions) {
			// A direct child is rarely in the SVG itself — use the union of
			// its descendant-leaf bboxes as the dot location.
			const childDesc = getDescendantIds(child.id, this.opts.structureTree);
			const bb = unionBBoxForIds(displaySvg, childDesc);
			if (!bb) continue;
			centroids.set(child.id, { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 });
		}

		// Draw connection arrows first (below dots)
		for (const conn of activeConnections) {
			const srcId  = parseInt(conn.sourceLayerId);
			const tgtId  = parseInt(conn.targetLayerId);
			const src    = centroids.get(srcId);
			const tgt    = centroids.get(tgtId);
			if (!src || !tgt) continue;
			this.drawConnectionArrow(overlaySvg, src, tgt, conn);
		}

		// Draw dots for each sub-region
		for (const child of subRegions) {
			const c = centroids.get(child.id);
			if (!c) continue;

			const childIdStr = child.id.toString();
			const matchingNotes = activeCellNotes.filter(n =>
				n.layerId === childIdStr || n.layerId === child.acronym.toLowerCase()
			);

			if (matchingNotes.length > 0) {
				// Colored dots for notes
				matchingNotes.forEach((note, i) => {
					const angle  = (i / matchingNotes.length) * Math.PI * 2;
					const offset = matchingNotes.length > 1 ? 10 : 0;
					const cx = c.x + Math.cos(angle) * offset;
					const cy = c.y + Math.sin(angle) * offset;
					const color = CELL_CLASS_COLORS[note.cellClass] ?? "#aaaaaa";
					this.drawDot(overlaySvg, cx, cy, color, true, () => {
						if (onDotClick) onDotClick(child.id, note.file);
					});
				});
			} else {
				// Gray dot — create note on click
				this.drawDot(overlaySvg, c.x, c.y, "#cccccc", false, () => {
					if (onDotClick) onDotClick(child.id, null);
				});
			}
		}

		// Make container relative for overlay positioning
		if (container.style.position !== "relative") {
			container.style.position = "relative";
		}
		container.appendChild(overlaySvg);
	}

	private drawDot(
		svg:       SVGSVGElement,
		cx:        number,
		cy:        number,
		fill:      string,
		isActive:  boolean,
		onClick:   () => void,
	): void {
		const circle = document.createElementNS(SVG_NS, "circle") as SVGCircleElement;
		circle.setAttribute("cx",    cx.toString());
		circle.setAttribute("cy",    cy.toString());
		circle.setAttribute("r",     "8");
		circle.setAttribute("fill",  fill);
		circle.setAttribute("stroke", isActive ? "#fff" : "#888");
		circle.setAttribute("stroke-width", "1.5");
		circle.style.cursor       = isActive ? "pointer" : "crosshair";
		circle.style.pointerEvents = "all";
		circle.addEventListener("click", onClick);
		svg.appendChild(circle);
	}

	private drawConnectionArrow(
		svg:  SVGSVGElement,
		src:  { x: number; y: number },
		tgt:  { x: number; y: number },
		conn: ActiveConnection,
	): void {
		const isWiki  = conn.style === "wikilink";
		const midX    = (src.x + tgt.x) / 2;
		const midY    = (src.y + tgt.y) / 2 - 20;

		const path = document.createElementNS(SVG_NS, "path") as SVGPathElement;
		const d    = `M ${src.x},${src.y} Q ${midX},${midY} ${tgt.x},${tgt.y}`;
		path.setAttribute("d", d);
		path.setAttribute("fill", "none");
		path.setAttribute("stroke", isWiki ? "rgba(150,150,150,0.4)" : "var(--interactive-accent)");
		path.setAttribute("stroke-width", isWiki ? "1" : "2");
		if (isWiki) path.setAttribute("stroke-dasharray", "4 3");
		path.setAttribute("marker-end", isWiki ? "url(#arrow-wiki)" : "url(#arrow-explicit)");
		path.style.pointerEvents = "none";
		svg.appendChild(path);

		if (!isWiki && conn.label) {
			const text = document.createElementNS(SVG_NS, "text") as SVGTextElement;
			text.setAttribute("x", midX.toString());
			text.setAttribute("y", (midY - 4).toString());
			text.setAttribute("text-anchor", "middle");
			text.setAttribute("font-size", "10");
			text.setAttribute("fill", "var(--text-muted)");
			text.textContent = conn.label;
			text.style.pointerEvents = "none";
			svg.appendChild(text);
		}
	}

	// ── Slider ────────────────────────────────────────────────────────────────────

	private buildSlider(sliderRow: HTMLElement): void {
		if (this.sectionIndices.length <= 1) return;

		sliderRow.addClass("neuro-section-slider-row");

		const label = sliderRow.createEl("span", { cls: "neuro-section-ap-label" });
		const updateLabel = (): void => {
			const i = this.sectionIndices[this.currentIdx];
			const s = i !== undefined ? this.sections[i] : undefined;
			label.textContent = s ? `AP: ${s.apPositionMm.toFixed(1)} mm` : "";
		};

		const slider = sliderRow.createEl("input");
		slider.type  = "range";
		slider.min   = "0";
		slider.max   = (this.sectionIndices.length - 1).toString();
		slider.value = this.currentIdx.toString();
		slider.addClass("neuro-section-slider");
		slider.addEventListener("input", () => {
			this.currentIdx = parseInt(slider.value);
			updateLabel();
			const svgWrap = this.container?.querySelector(".neuro-section-svg-wrap") as HTMLElement | null;
			if (svgWrap) void this.renderSection(svgWrap);
		});

		updateLabel();

		// "Use this slice" — only rendered when the host wired an onSliceSelected handler.
		if (this.opts.onSliceSelected) {
			const btn = sliderRow.createEl("button", {
				text: "Use this slice",
				cls:  "neuro-section-use-slice-btn mod-cta",
			});
			btn.addEventListener("click", () => {
				if (this.currentSvg && this.currentSection && this.opts.onSliceSelected) {
					this.opts.onSliceSelected(this.currentSvg, this.currentSection);
				}
			});
		}
	}
}

// ── Descendant-aware SVG helpers ──────────────────────────────────────────────

/**
 * Iterates every <path> (or other element) with a `structure_id` attribute
 * whose numeric value is in `ids`. Used for both highlighting and bbox union.
 */
function* descendantPaths(
	root: Element,
	ids:  Set<number>,
): Generator<SVGElement> {
	const nodes = root.querySelectorAll("[structure_id]");
	for (const n of Array.from(nodes)) {
		const sid = parseInt(n.getAttribute("structure_id") ?? "", 10);
		if (Number.isFinite(sid) && ids.has(sid)) yield n as SVGElement;
	}
}

/**
 * Returns the union bounding box of every path whose `structure_id` is in
 * `ids`, or null if none are present / measurable.
 */
function unionBBoxForIds(
	root: Element,
	ids:  Set<number>,
): { x: number; y: number; width: number; height: number } | null {
	let out: { x: number; y: number; width: number; height: number } | null = null;
	for (const el of descendantPaths(root, ids)) {
		let b: DOMRect;
		try { b = (el as unknown as SVGGraphicsElement).getBBox(); } catch { continue; }
		if (!b || b.width === 0 && b.height === 0) continue;
		if (!out) {
			out = { x: b.x, y: b.y, width: b.width, height: b.height };
		} else {
			const x1 = Math.min(out.x, b.x);
			const y1 = Math.min(out.y, b.y);
			const x2 = Math.max(out.x + out.width,  b.x + b.width);
			const y2 = Math.max(out.y + out.height, b.y + b.height);
			out = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
		}
	}
	return out;
}

function buildArrowMarker(
	id:           string,
	fill:         string,
	stroke:       string,
	strokeWidth:  string | null,
): SVGMarkerElement {
	const marker = document.createElementNS(SVG_NS, "marker");
	marker.setAttribute("id",           id);
	marker.setAttribute("markerWidth",  "6");
	marker.setAttribute("markerHeight", "6");
	marker.setAttribute("refX",         "5");
	marker.setAttribute("refY",         "3");
	marker.setAttribute("orient",       "auto");
	const path = document.createElementNS(SVG_NS, "path");
	path.setAttribute("d",      "M0,0 L6,3 L0,6");
	path.setAttribute("fill",   fill);
	path.setAttribute("stroke", stroke);
	if (strokeWidth) path.setAttribute("stroke-width", strokeWidth);
	marker.appendChild(path);
	return marker;
}
