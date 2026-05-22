// ──────────────────────────────────────────────────────────────────────────────
// cellGlyph.ts  —  Renders schematic cell bodies and real SWC morphologies
// on top of a layered viewpoint SVG.
//
// Used inline by ViewpointView when the user has a subregion focused. The
// glyph (soma + stylized arbors) and the morphology polyline share the same
// coordinate space as the surrounding layer polygons.
// ──────────────────────────────────────────────────────────────────────────────

import type { DataAdapter } from "obsidian";
import type { CellTypeFrontmatter, Compartment } from "./types";
import { fetchNeuronSwc, project2d, Point2D, SwcNode } from "./api/neuromorpho";

export type { Compartment } from "./types";

const SVG_NS = "http://www.w3.org/2000/svg";

export interface Centroid { cx: number; cy: number; w: number; h: number; }

export interface MorphologyRenderOptions {
	/** If provided, only segments whose child node type is enabled are drawn.
	 *  "dendrite" enables both basal and apical. If undefined, draw everything. */
	compartments?: Set<Compartment>;
	/** User-defined placement overriding `focus`. When supplied, the morphology
	 *  is drawn centred at (cx, cy), the auto-fit scale is multiplied by `scale`,
	 *  and the result is rotated clockwise by `rotation` degrees about (cx, cy). */
	placement?: { cx: number; cy: number; scale: number; rotation: number };
}

export interface CellGlyphRenderOptions {
	/** Override soma position. Only translation matters for schematic glyphs;
	 *  arbor lines still run from this point to the layer-centroid targets. */
	placement?: { cx: number; cy: number };
}

/** SWC node type codes → compartment names (1=soma, 2=axon, 3=basal, 4=apical). */
function swcTypeToCompartment(type: number): Compartment | null {
	switch (type) {
		case 1: return "soma";
		case 2: return "axon";
		case 3: return "basal";
		case 4: return "apical";
		default: return null;
	}
}

function compartmentEnabled(
	c:   Compartment | null,
	set: Set<Compartment> | undefined,
): boolean {
	if (!set) return true;
	if (!c) return false;
	if (set.has(c)) return true;
	if ((c === "basal" || c === "apical") && set.has("dendrite")) return true;
	return false;
}

/** CSS variable name that encodes this cell class's palette colour. */
export function cellClassColor(cellClass: string): string {
	switch (cellClass) {
		case "pyramidal":   return "--color-red";
		case "interneuron": return "--color-purple";
		case "granule":     return "--color-green";
		case "glial":       return "--color-cyan";
		default:            return "--text-muted";
	}
}

/**
 * Draws one stylized cell body with tapered arbors reaching into the layers
 * listed in `fm.dendrite_layers` / `fm.axon_layers`.
 */
export function drawCellGlyph(
	group:     SVGGElement,
	focus:     Centroid,
	fm:        Partial<CellTypeFrontmatter>,
	centroids: Map<string, Centroid>,
	opts?:     CellGlyphRenderOptions,
): void {
	const colorVar = cellClassColor(fm.cell_class ?? "other");
	const rDiag    = Math.sqrt(focus.w * focus.w + focus.h * focus.h);
	const somaR    = Math.max(rDiag * 0.03, 3);
	const cx       = opts?.placement?.cx ?? focus.cx;
	const cy       = opts?.placement?.cy ?? focus.cy;

	const drawArbors = (acronyms: string[] | undefined, kind: "dendrite" | "axon") => {
		if (!acronyms) return;
		for (const acronym of acronyms) {
			const target = centroids.get(acronym.trim().toLowerCase());
			if (!target) continue;
			const line = document.createElementNS(SVG_NS, "line") as SVGLineElement;
			line.setAttribute("x1", cx.toString());
			line.setAttribute("y1", cy.toString());
			line.setAttribute("x2", target.cx.toString());
			line.setAttribute("y2", target.cy.toString());
			line.setAttribute("stroke", `var(${colorVar})`);
			line.setAttribute("stroke-width", (somaR * 0.5).toString());
			line.setAttribute("class",
				kind === "dendrite" ? "neuro-cell-arbor-dendrite" : "neuro-cell-arbor-axon");
			group.appendChild(line);
		}
	};

	drawArbors(fm.dendrite_layers, "dendrite");
	drawArbors(fm.axon_layers,     "axon");

	const soma = document.createElementNS(SVG_NS, "circle") as SVGCircleElement;
	soma.setAttribute("cx",    cx.toString());
	soma.setAttribute("cy",    cy.toString());
	soma.setAttribute("r",     somaR.toString());
	soma.setAttribute("fill",  `var(${colorVar})`);
	soma.setAttribute("class", "neuro-cell-soma");
	group.appendChild(soma);
}

/**
 * Fetches a NeuroMorpho SWC (or reads from cache) and renders the projected
 * neuron as parent→child line segments centred on the focus polygon.
 */
export async function drawMorphology(
	group:   SVGGElement,
	focus:   Centroid,
	fm:      Partial<CellTypeFrontmatter>,
	plane:   "coronal" | "sagittal",
	adapter: DataAdapter,
	opts?:   MorphologyRenderOptions,
): Promise<void> {
	const identifier = fm.morphology_source;
	if (!identifier || !identifier.toLowerCase().startsWith("neuromorpho:")) return;

	let nodes: SwcNode[];
	try {
		nodes = await fetchNeuronSwc(identifier, adapter);
	} catch (err) {
		console.warn("[neuro-mindmap] morphology fetch failed:", err);
		return;
	}

	drawMorphologyNodes(group, focus, fm, plane, nodes, opts);
}

/**
 * Synchronous render of pre-fetched SWC nodes — used by the interactive
 * placement preview, which needs to redraw on every drag tick without an
 * awaitable round-trip through `fetchNeuronSwc`.
 */
export function drawMorphologyNodes(
	group: SVGGElement,
	focus: Centroid,
	fm:    Partial<CellTypeFrontmatter>,
	plane: "coronal" | "sagittal",
	nodes: SwcNode[],
	opts?: MorphologyRenderOptions,
): void {
	const projected = project2d(nodes, plane);
	if (projected.length === 0) return;

	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const p of projected) {
		if (p.x < minX) minX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.x > maxX) maxX = p.x;
		if (p.y > maxY) maxY = p.y;
	}
	const morphW = maxX - minX || 1;
	const morphH = maxY - minY || 1;
	const targetDiag = Math.sqrt(focus.w * focus.w + focus.h * focus.h) * 0.4;
	const morphDiag  = Math.sqrt(morphW * morphW + morphH * morphH);
	const baseScale  = targetDiag / morphDiag;
	const placement  = opts?.placement;
	const scale      = baseScale * (placement?.scale ?? 1);
	const targetCx   = placement?.cx ?? focus.cx;
	const targetCy   = placement?.cy ?? focus.cy;
	const rotRad     = ((placement?.rotation ?? 0) * Math.PI) / 180;
	const cosR       = Math.cos(rotRad);
	const sinR       = Math.sin(rotRad);

	const morphCx = (minX + maxX) / 2;
	const morphCy = (minY + maxY) / 2;
	const map = new Map<number, Point2D>();
	for (let i = 0; i < projected.length; i++) {
		const n = nodes[i]!;
		map.set(n.id, projected[i]!);
	}

	const transform = (p: Point2D): { x: number; y: number } => {
		const dx = (p.x - morphCx) * scale;
		const dy = (p.y - morphCy) * scale;
		return {
			x: targetCx + dx * cosR - dy * sinR,
			y: targetCy + dx * sinR + dy * cosR,
		};
	};

	const colorVar      = cellClassColor(fm.cell_class ?? "other");
	const compartments  = opts?.compartments;
	const somaEnabled   = compartmentEnabled("soma", compartments);

	// Build child-of map so we can draw connected polylines per branch.
	// One <line> per SWC node renders an isolated round cap at every leaf —
	// which is what produced the "scattered red dots" artefact. Polylines
	// only place caps at actual branch terminals.
	const childrenOf = new Map<number, SwcNode[]>();
	for (const n of nodes) {
		if (n.parent < 0) continue;
		const arr = childrenOf.get(n.parent);
		if (arr) arr.push(n);
		else     childrenOf.set(n.parent, [n]);
	}

	const isVisible = (n: SwcNode): boolean => {
		const compartment = swcTypeToCompartment(n.type);
		if (compartment === null) return false;          // drop type 0/5+ (custom/unknown)
		if (compartment === "soma") return false;        // soma drawn as a circle below
		return compartmentEnabled(compartment, compartments);
	};

	const drawn = new Set<number>();
	const drawBranchFrom = (start: SwcNode): void => {
		// Walk linearly until we hit a branch point (>1 child) or terminal.
		const points: { x: number; y: number }[] = [];
		const startParent = map.get(start.parent);
		if (startParent) points.push(transform(startParent));
		let current: SwcNode | undefined = start;
		while (current) {
			if (drawn.has(current.id)) break;
			drawn.add(current.id);
			const p = map.get(current.id);
			if (p) points.push(transform(p));
			const kids: SwcNode[] = childrenOf.get(current.id) ?? [];
			const visibleKids: SwcNode[] = kids.filter(isVisible);
			if (visibleKids.length === 1) { current = visibleKids[0]!; continue; }
			// Branch or terminal — emit polyline, then recurse for each child.
			emitPolyline(points, start);
			for (const k of visibleKids) drawBranchFrom(k);
			return;
		}
		emitPolyline(points, start);
	};

	const emitPolyline = (
		pts:    { x: number; y: number }[],
		sample: SwcNode,
	): void => {
		if (pts.length < 2) return;
		const poly = document.createElementNS(SVG_NS, "polyline") as SVGPolylineElement;
		poly.setAttribute("points",
			pts.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" "));
		poly.setAttribute("fill",   "none");
		poly.setAttribute("stroke", `var(${colorVar})`);
		poly.setAttribute("stroke-width",
			Math.max(sample.radius * scale, 0.6).toString());
		poly.setAttribute("stroke-linejoin", "round");
		poly.setAttribute("stroke-linecap",  "butt");
		poly.setAttribute("class", `neuro-cell-morph-seg swc-type-${sample.type}`);
		group.appendChild(poly);
	};

	// Roots of visible branches: any visible node whose parent is invisible
	// (or a soma, or absent). That's where each polyline run begins.
	for (const n of nodes) {
		if (!isVisible(n)) continue;
		if (drawn.has(n.id)) continue;
		const parent = nodes.find(p => p.id === n.parent);
		const parentVisible = parent && isVisible(parent);
		if (parentVisible) continue;
		drawBranchFrom(n);
	}

	if (somaEnabled) {
		let sx = 0, sy = 0, sr = 0, scount = 0;
		for (const node of nodes) {
			if (node.type !== 1) continue;
			const p = map.get(node.id);
			if (!p) continue;
			const t = transform(p);
			sx += t.x; sy += t.y;
			sr += node.radius * scale;
			scount++;
		}
		if (scount > 0) {
			const soma = document.createElementNS(SVG_NS, "circle") as SVGCircleElement;
			soma.setAttribute("cx", (sx / scount).toString());
			soma.setAttribute("cy", (sy / scount).toString());
			soma.setAttribute("r",  Math.max(sr / scount, 2).toString());
			soma.setAttribute("fill", `var(${colorVar})`);
			soma.setAttribute("class", "neuro-cell-morph-soma");
			group.appendChild(soma);
		}
	}
}
