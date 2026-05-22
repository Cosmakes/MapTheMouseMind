// ──────────────────────────────────────────────────────────────────────────────
// AddCellModal.ts
//
// Picker for morphology candidates (or a "no morphology" schematic fallback).
// Walks the Allen ancestor chain from the focused leaf upward, stopping at the
// first level with NeuroMorpho matches. The modal banner names the level used
// when the leaf itself has no reconstructions.
//
// The modal does NOT create the cell note itself — it hands the chosen pick
// (candidate or "schematic") back to the caller via callbacks. The caller
// (ViewpointView) then enters interactive placement mode and writes the file.
//
// Each candidate row shows a small SVG thumbnail of the morphology, lazy-
// loaded via IntersectionObserver from the existing on-disk SWC cache.
// ──────────────────────────────────────────────────────────────────────────────

import { App, Modal, Setting } from "obsidian";
import { createNeuroMorphoSource, fetchNeuronSwc, project2d, SwcNode, Point2D } from "./api/neuromorpho";
import {
	getAncestors,
	type AllenStructureFlat,
} from "./api/allenStructureCache";
import type {
	MorphologyCandidate,
	MorphologyQuery,
	MorphologySource,
} from "./api/morphologySource";

const SVG_NS = "http://www.w3.org/2000/svg";

export interface AddCellModalOptions {
	leafAcronym:      string;
	leafName:         string;
	leafAllenId:      number;
	siblingAcronyms:  string[];
	structureTree:    Map<number, AllenStructureFlat>;
	/** Called when the user picks a morphology candidate. Modal closes first. */
	onPickCandidate:  (c: MorphologyCandidate) => void;
	/** Called when the user picks "no morphology". Modal closes first. */
	onPickSchematic:  () => void;
}

interface SearchResolution {
	candidates:    MorphologyCandidate[];
	matchedLevel:  AllenStructureFlat;
	leafLevel:     AllenStructureFlat;
}

export class AddCellModal extends Modal {
	private opts:       AddCellModalOptions;
	private resolution: SearchResolution | null = null;
	private filter = "";
	private loading = true;
	private error: string | null = null;

	private listEl:   HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private bannerEl: HTMLElement | null = null;

	/** Cached parsed SWC nodes for already-fetched thumbnails, keyed by
	 *  candidate identifier. The SVG element is rebuilt from these on each
	 *  render so slot re-renders never need to clone DOM. */
	private thumbCache = new Map<string, SwcNode[]>();
	/** In-flight thumbnail fetches, so we don't double-trigger on re-render. */
	private thumbInflight = new Set<string>();
	private thumbObserver: IntersectionObserver | null = null;

	constructor(app: App, opts: AddCellModalOptions) {
		super(app);
		this.opts = opts;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("neuro-add-cell-modal");

		contentEl.createEl("h2", { text: `Add cell to ${this.opts.leafAcronym}` });
		contentEl.createEl("p", {
			text: `Searching morphology databases for neurons in ${this.opts.leafAcronym}…`,
			cls:  "setting-item-description",
		});

		this.bannerEl = contentEl.createDiv({ cls: "neuro-add-cell-banner" });

		new Setting(contentEl)
			.setName("Filter")
			.addText(text =>
				text.setPlaceholder("Name or cell type…")
					.onChange(v => { this.filter = v.trim().toLowerCase(); this.renderList(); })
			);

		this.statusEl = contentEl.createDiv({ cls: "neuro-add-cell-status" });
		this.listEl   = contentEl.createDiv({ cls: "neuro-add-cell-list" });

		new Setting(contentEl)
			.addButton(btn =>
				btn.setButtonText("Create schematic cell (no morphology)")
					.onClick(() => this.pickSchematic())
			)
			.addButton(btn =>
				btn.setButtonText("Cancel").onClick(() => this.close())
			);

		// Single shared observer for all rows in the list.
		this.thumbObserver = new IntersectionObserver(entries => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				const slot = entry.target as HTMLElement;
				const id   = slot.dataset.candidateId;
				if (!id) continue;
				this.thumbObserver?.unobserve(slot);
				void this.loadThumbnail(slot, id);
			}
		}, { root: this.listEl, rootMargin: "100px 0px" });

		void this.runSearch();
	}

	onClose(): void {
		this.thumbObserver?.disconnect();
		this.thumbObserver = null;
		this.contentEl.empty();
	}

	// ── Search ─────────────────────────────────────────────────────────────────

	private async runSearch(): Promise<void> {
		const tree   = this.opts.structureTree;
		const leaf   = tree.get(this.opts.leafAllenId);
		if (!leaf) {
			this.loading = false;
			this.error   = `Allen structure ${this.opts.leafAllenId} not in cache.`;
			this.renderList();
			return;
		}
		const chain: AllenStructureFlat[] = [leaf, ...getAncestors(leaf.id, tree)];
		const source: MorphologySource = createNeuroMorphoSource(this.app.vault.adapter);

		try {
			for (const level of chain) {
				const query: MorphologyQuery = {
					leafAcronym:   this.opts.leafAcronym,
					leafName:      this.opts.leafName,
					regionAcronym: level.acronym,
					species:       "mouse",
				};
				const candidates = await source.search(query);
				if (candidates.length > 0) {
					this.resolution = { candidates, matchedLevel: level, leafLevel: leaf };
					break;
				}
			}
			this.loading = false;
			if (!this.resolution) {
				this.resolution = { candidates: [], matchedLevel: leaf, leafLevel: leaf };
			}
		} catch (err) {
			this.loading = false;
			this.error   = (err as Error).message;
		}
		this.renderList();
	}

	// ── List rendering ─────────────────────────────────────────────────────────

	private renderList(): void {
		const status = this.statusEl;
		const list   = this.listEl;
		const banner = this.bannerEl;
		if (!status || !list || !banner) return;
		status.empty();
		list.empty();
		banner.empty();

		if (this.loading) {
			status.createEl("p", { text: "Loading…", cls: "neuro-add-cell-loading" });
			return;
		}
		if (this.error) {
			status.createEl("p", {
				text: `Search failed: ${this.error}. You can still create a schematic cell below.`,
				cls:  "neuro-add-cell-error",
			});
			return;
		}
		const r = this.resolution;
		if (!r) return;
		if (r.candidates.length === 0) {
			status.createEl("p", {
				text: `No reconstructions found for ${r.leafLevel.acronym} or any ancestor region. Use the schematic cell button below.`,
			});
			return;
		}

		// Banner only when the matched level isn't the leaf itself.
		if (r.matchedLevel.id !== r.leafLevel.id) {
			banner.addClass("is-fallback");
			banner.createEl("p", {
				text: `No reconstructions in ${r.leafLevel.acronym} (${r.leafLevel.name}). Showing matches from ${r.matchedLevel.acronym} (${r.matchedLevel.name}) — these are not specific to your subregion.`,
			});
		}

		const f  = this.filter;
		const filtered = f.length === 0
			? r.candidates
			: r.candidates.filter(c =>
				c.name.toLowerCase().includes(f) ||
				c.cellType.toLowerCase().includes(f));

		status.createEl("p", {
			text: `${filtered.length} of ${r.candidates.length} candidate${r.candidates.length === 1 ? "" : "s"}.`,
			cls:  "neuro-add-cell-count",
		});

		for (const c of filtered.slice(0, 200)) {
			this.renderRow(list, c);
		}
	}

	private renderRow(parent: HTMLElement, c: MorphologyCandidate): void {
		const row = parent.createDiv({ cls: "neuro-add-cell-row" });

		const thumb = row.createDiv({ cls: "neuro-add-cell-thumb" });
		thumb.dataset.candidateId = c.identifier;
		const cached = this.thumbCache.get(c.identifier);
		if (cached) {
			const svg = buildThumbnailSvg(cached);
			if (svg) thumb.appendChild(svg);
		} else {
			thumb.createDiv({ cls: "neuro-add-cell-thumb-placeholder" });
			this.thumbObserver?.observe(thumb);
		}

		const info = row.createDiv({ cls: "neuro-add-cell-info" });
		info.createDiv({ text: c.name, cls: "neuro-add-cell-name" });
		const meta: string[] = [];
		if (c.cellType)    meta.push(c.cellType);
		if (c.brainRegion) meta.push(c.brainRegion);
		if (c.species)     meta.push(c.species);
		info.createDiv({ text: meta.join(" · "), cls: "neuro-add-cell-meta" });

		row.createDiv({ text: c.source, cls: "neuro-add-cell-badge" });

		const btn = row.createEl("button", {
			text: "Use this",
			cls:  "mod-cta neuro-add-cell-use-btn",
		});
		btn.addEventListener("click", () => this.pickCandidate(c));
	}

	// ── Picks ──────────────────────────────────────────────────────────────────

	private pickCandidate(c: MorphologyCandidate): void {
		const cb = this.opts.onPickCandidate;
		this.close();
		cb(c);
	}

	private pickSchematic(): void {
		const cb = this.opts.onPickSchematic;
		this.close();
		cb();
	}

	// ── Thumbnails ─────────────────────────────────────────────────────────────

	private async loadThumbnail(slot: HTMLElement, identifier: string): Promise<void> {
		if (this.thumbCache.has(identifier) || this.thumbInflight.has(identifier)) return;
		this.thumbInflight.add(identifier);
		let nodes: SwcNode[];
		try {
			nodes = await fetchNeuronSwc(identifier, this.app.vault.adapter);
		} catch {
			this.thumbInflight.delete(identifier);
			slot.empty();
			slot.createDiv({ cls: "neuro-add-cell-thumb-placeholder is-failed" });
			return;
		}
		this.thumbCache.set(identifier, nodes);
		this.thumbInflight.delete(identifier);
		// The slot may have been re-rendered between trigger and resolution.
		// Look up the current slot for this identifier and update it in place.
		const list = this.listEl;
		if (!list) return;
		const live = list.querySelector(
			`.neuro-add-cell-thumb[data-candidate-id="${cssEscape(identifier)}"]`,
		) as HTMLElement | null;
		if (!live) return;
		const svg = buildThumbnailSvg(nodes);
		if (!svg) return;
		live.empty();
		live.appendChild(svg);
	}
}

/** Builds a 64×64 inline SVG showing all branches of an SWC, bbox-fit.
 *  Returns null when the SWC has no projectable nodes. */
function buildThumbnailSvg(nodes: SwcNode[]): SVGSVGElement | null {
	const projected: Point2D[] = project2d(nodes, "coronal");
	if (projected.length === 0) return null;

	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const p of projected) {
		if (p.x < minX) minX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.x > maxX) maxX = p.x;
		if (p.y > maxY) maxY = p.y;
	}
	const w = (maxX - minX) || 1;
	const h = (maxY - minY) || 1;
	const side = Math.max(w, h);
	const cx   = (minX + maxX) / 2;
	const cy   = (minY + maxY) / 2;
	const pad  = side * 0.08;
	const vbX  = cx - side / 2 - pad;
	const vbY  = cy - side / 2 - pad;
	const vbS  = side + pad * 2;

	const map = new Map<number, Point2D>();
	for (let i = 0; i < projected.length; i++) {
		const n = nodes[i]!;
		map.set(n.id, projected[i]!);
	}
	const childrenOf = new Map<number, SwcNode[]>();
	for (const n of nodes) {
		if (n.parent < 0) continue;
		const arr = childrenOf.get(n.parent);
		if (arr) arr.push(n);
		else     childrenOf.set(n.parent, [n]);
	}
	const isVisible = (n: SwcNode): boolean => n.type >= 1 && n.type <= 4 && n.type !== 1;

	const drawn = new Set<number>();
	const polylinePointStrings: string[] = [];

	const emit = (pts: Point2D[]): void => {
		if (pts.length < 2) return;
		polylinePointStrings.push(
			pts.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ")
		);
	};
	const walk = (start: SwcNode): void => {
		const pts: Point2D[] = [];
		const startParent = map.get(start.parent);
		if (startParent) pts.push(startParent);
		let current: SwcNode | undefined = start;
		while (current) {
			if (drawn.has(current.id)) break;
			drawn.add(current.id);
			const p = map.get(current.id);
			if (p) pts.push(p);
			const kids: SwcNode[] = (childrenOf.get(current.id) ?? []).filter(isVisible);
			if (kids.length === 1) { current = kids[0]!; continue; }
			emit(pts);
			for (const k of kids) walk(k);
			return;
		}
		emit(pts);
	};
	for (const n of nodes) {
		if (!isVisible(n)) continue;
		if (drawn.has(n.id)) continue;
		const parent = nodes.find(p => p.id === n.parent);
		if (parent && isVisible(parent)) continue;
		walk(n);
	}

	// Soma circle (averaged from type-1 nodes).
	let sx = 0, sy = 0, scount = 0;
	for (const n of nodes) {
		if (n.type !== 1) continue;
		const p = map.get(n.id);
		if (!p) continue;
		sx += p.x; sy += p.y; scount++;
	}

	const svg = document.createElementNS(SVG_NS, "svg");
	svg.setAttribute("viewBox", `${vbX} ${vbY} ${vbS} ${vbS}`);
	svg.setAttribute("class", "neuro-add-cell-thumb-svg");
	svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

	const strokesGroup = document.createElementNS(SVG_NS, "g");
	strokesGroup.setAttribute("fill", "none");
	strokesGroup.setAttribute("stroke", "currentColor");
	strokesGroup.setAttribute("stroke-width", (vbS * 0.012).toFixed(3));
	strokesGroup.setAttribute("stroke-linejoin", "round");
	strokesGroup.setAttribute("stroke-linecap", "butt");
	for (const points of polylinePointStrings) {
		const pl = document.createElementNS(SVG_NS, "polyline");
		pl.setAttribute("points", points);
		strokesGroup.appendChild(pl);
	}
	svg.appendChild(strokesGroup);

	const somaGroup = document.createElementNS(SVG_NS, "g");
	somaGroup.setAttribute("fill", "currentColor");
	if (scount > 0) {
		const circle = document.createElementNS(SVG_NS, "circle");
		circle.setAttribute("cx", (sx / scount).toFixed(2));
		circle.setAttribute("cy", (sy / scount).toFixed(2));
		circle.setAttribute("r", (vbS * 0.025).toFixed(2));
		somaGroup.appendChild(circle);
	}
	svg.appendChild(somaGroup);

	return svg;
}

/** Minimal CSS.escape polyfill for older Electron — identifiers are NeuroMorpho
 *  names (alphanum + underscore + colon) so a tight regex is enough. */
function cssEscape(s: string): string {
	return s.replace(/["\\]/g, "\\$&");
}
