// ──────────────────────────────────────────────────────────────────────────────
// cellGlyph.ts  —  Renders schematic cell bodies and real SWC morphologies
// on top of a layered viewpoint SVG.
//
// Used inline by ViewpointView when the user has a subregion focused. The
// glyph (soma + stylized arbors) and the morphology polyline share the same
// coordinate space as the surrounding layer polygons.
// ──────────────────────────────────────────────────────────────────────────────

import type { DataAdapter } from "obsidian";
import type { CellTypeFrontmatter, Compartment, SomaShape } from "./types";
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
	/** Override soma position. Arbor lines still run from this point to the
	 *  layer-centroid targets; `scale` multiplies the soma radius (and, via
	 *  it, the arbor stroke width) so schematic cells can be resized without
	 *  detaching their arbors from the anatomically meaningful endpoints.
	 *  `rotation` (degrees, clockwise) orients the soma silhouette and the
	 *  cosmetic dendrite layout — anatomy-tethered arbors are unaffected. */
	placement?: { cx: number; cy: number; scale?: number; rotation?: number };
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
 * listed in `fm.dendrite_layers` / `fm.axon_layers`. Optionally adds cosmetic
 * primary dendrites with recursive bifurcation and chooses the soma silhouette
 * per `fm.soma_shape`.
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
	const scale    = opts?.placement?.scale ?? 1;
	const somaR    = Math.max(rDiag * 0.03, 3) * scale;
	const cx       = opts?.placement?.cx ?? focus.cx;
	const cy       = opts?.placement?.cy ?? focus.cy;
	const rotDeg   = opts?.placement?.rotation ?? 0;
	const rotRad   = (rotDeg * Math.PI) / 180;
	const strokeW  = somaR * 0.5;

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
			line.setAttribute("stroke-width", strokeW.toString());
			line.setAttribute("class",
				kind === "dendrite" ? "neuro-cell-arbor-dendrite" : "neuro-cell-arbor-axon");
			group.appendChild(line);
		}
	};

	drawArbors(fm.dendrite_layers, "dendrite");
	drawArbors(fm.axon_layers,     "axon");

	// ── Cosmetic dendrites ─────────────────────────────────────────────────
	// Independent of dendrite_layers/axon_layers — they live purely for visual
	// distinction and are oriented by `rotation`.
	const dendriteCount = Math.max(0, Math.min(12, Math.round(fm.primary_dendrites ?? 0)));
	if (dendriteCount > 0) {
		const spreadDeg   = Math.max(0, Math.min(360, fm.dendrite_spread_deg ?? 360));
		const spreadRad   = (spreadDeg * Math.PI) / 180;
		const depthMax    = Math.max(0, Math.min(3, Math.round(fm.branch_depth ?? 0)));
		const arb         = Math.max(0, Math.min(1, fm.arborization_strength ?? 0.5));
		const baseLen     = somaR * (3 + 4 * arb);
		const forkHalfRad = ((15 + 25 * arb) * Math.PI) / 180;
		// Centre the fan along the cell's "up" (-π/2 in screen coords) rotated
		// by the placement rotation.
		const centerTheta = -Math.PI / 2 + rotRad;
		const startTheta  = centerTheta - spreadRad / 2;

		const emitSeg = (
			x1: number, y1: number, x2: number, y2: number, width: number,
		): void => {
			const seg = document.createElementNS(SVG_NS, "line") as SVGLineElement;
			seg.setAttribute("x1", x1.toFixed(2));
			seg.setAttribute("y1", y1.toFixed(2));
			seg.setAttribute("x2", x2.toFixed(2));
			seg.setAttribute("y2", y2.toFixed(2));
			seg.setAttribute("stroke", `var(${colorVar})`);
			seg.setAttribute("stroke-width", width.toString());
			seg.setAttribute("stroke-linecap", "round");
			seg.setAttribute("class", "neuro-cell-dendrite");
			group.appendChild(seg);
		};

		// Recursive branch: emit the first half of the segment, then fork
		// twice from the midpoint with shrinking children until depth hits 0.
		const drawBranch = (
			x1: number, y1: number, theta: number, len: number,
			width: number, depth: number,
		): void => {
			const x2 = x1 + Math.cos(theta) * len;
			const y2 = y1 + Math.sin(theta) * len;
			if (depth <= 0) {
				emitSeg(x1, y1, x2, y2, width);
				return;
			}
			const midX = x1 + Math.cos(theta) * (len * 0.5);
			const midY = y1 + Math.sin(theta) * (len * 0.5);
			emitSeg(x1, y1, midX, midY, width);
			const childLen   = len * 0.55 * (1 - 0.15 * arb);
			const childWidth = Math.max(width * 0.7, strokeW * 0.35);
			drawBranch(midX, midY, theta - forkHalfRad, childLen, childWidth, depth - 1);
			drawBranch(midX, midY, theta + forkHalfRad, childLen, childWidth, depth - 1);
		};

		for (let i = 0; i < dendriteCount; i++) {
			const theta = dendriteCount === 1
				? centerTheta
				: startTheta + (spreadRad * i) / (dendriteCount - 1);
			drawBranch(cx, cy, theta, baseLen, strokeW, depthMax);
		}
	}

	// ── Soma silhouette ────────────────────────────────────────────────────
	const shape: SomaShape = (fm.soma_shape ?? "circle");
	if (shape === "triangle") {
		const apex = -Math.PI / 2 + rotRad;
		const pts: string[] = [];
		for (let i = 0; i < 3; i++) {
			const t = apex + (i * 2 * Math.PI) / 3;
			pts.push(`${(cx + Math.cos(t) * somaR).toFixed(2)},${(cy + Math.sin(t) * somaR).toFixed(2)}`);
		}
		const tri = document.createElementNS(SVG_NS, "polygon") as SVGPolygonElement;
		tri.setAttribute("points", pts.join(" "));
		tri.setAttribute("fill",   `var(${colorVar})`);
		tri.setAttribute("class",  "neuro-cell-soma");
		group.appendChild(tri);
	} else if (shape === "oval") {
		const ell = document.createElementNS(SVG_NS, "ellipse") as SVGEllipseElement;
		ell.setAttribute("cx", cx.toString());
		ell.setAttribute("cy", cy.toString());
		ell.setAttribute("rx", (somaR * 0.75).toString());
		ell.setAttribute("ry", (somaR * 1.2).toString());
		ell.setAttribute("fill",  `var(${colorVar})`);
		ell.setAttribute("class", "neuro-cell-soma");
		ell.setAttribute("transform", `rotate(${rotDeg} ${cx} ${cy})`);
		group.appendChild(ell);
	} else {
		const soma = document.createElementNS(SVG_NS, "circle") as SVGCircleElement;
		soma.setAttribute("cx",    cx.toString());
		soma.setAttribute("cy",    cy.toString());
		soma.setAttribute("r",     somaR.toString());
		soma.setAttribute("fill",  `var(${colorVar})`);
		soma.setAttribute("class", "neuro-cell-soma");
		group.appendChild(soma);
	}
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
