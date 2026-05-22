// ──────────────────────────────────────────────────────────────────────────────
// viewpoints.ts  —  Viewpoint note discovery, parsing, and generation.
//
// A "viewpoint" is a schematic 2D snapshot of a single Allen atlas slice,
// restricted to one brain structure. Stored as a markdown note in
// `neuro/viewpoints/` with:
//   • frontmatter — metadata (parent_region_id, allen_id, plane, ap_mm, view_box)
//   • body       — fenced ```viewpoint code block containing JSON { layers: […] }
//                  where each layer has the SVG path 'd' for one Allen leaf.
//
// Why JSON in the body rather than frontmatter: path `d` strings can be many
// kilobytes and YAML handles them poorly (escaping, line folding).
// ──────────────────────────────────────────────────────────────────────────────

import { App, TFile, stringifyYaml } from "obsidian";
import type { AllenStructureFlat } from "./api/allenStructureCache";
import { CellTypeFrontmatter, ViewpointFrontmatter, ViewpointLayer } from "./types";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Data extracted from one Allen section ready to be written as a viewpoint note. */
export interface ViewpointPayload {
	allen_id:      number;
	parent_region_id: string;
	plane:         "coronal" | "sagittal";
	section_id:    number;
	section_order: number;
	ap_mm:         number;
	view_box:      string;
	layers:        ViewpointLayer[];
}

// ── Discovery ─────────────────────────────────────────────────────────────────

/**
 * Returns all viewpoint notes whose `allen_id` matches the given structure.
 * Mirrors the metadataCache query pattern used elsewhere in the plugin.
 *
 * `viewpointsRoot`, when provided, restricts results to that folder.
 */
export function discoverViewpoints(
	app: App,
	allenId: number,
	viewpointsRoot?: string,
): TFile[] {
	const prefix = viewpointsRoot ? `${viewpointsRoot}/` : null;
	const result: TFile[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		if (prefix && !file.path.startsWith(prefix)) continue;
		const fm = app.metadataCache.getFileCache(file)?.frontmatter as
			Partial<ViewpointFrontmatter> | undefined;
		if (fm?.entity_type !== "viewpoint") continue;
		if (fm.allen_id !== allenId) continue;
		result.push(file);
	}
	return result;
}

/**
 * Returns cell-type notes associated with a specific Allen leaf layer
 * **scoped to one viewpoint folder**. Cells live at
 * `<viewpoint-folder>/cells/*.md`; passing `cellsFolder` filters out
 * cells from other viewpoints so each viewpoint maintains its own roster.
 *
 * A cell-type note "belongs" to a layer if either:
 *   - its `layer_id` matches the leaf acronym (case-insensitive), OR
 *   - its `brain_region` matches the leaf acronym AND it has no layer_id set
 */
export function getCellTypesForLayer(
	app:          App,
	leafAcronym:  string,
	cellsFolder?: string,
): TFile[] {
	const target = leafAcronym.toLowerCase();
	const folderPrefix = cellsFolder ? `${cellsFolder}/` : null;
	const result: TFile[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		if (folderPrefix && !file.path.startsWith(folderPrefix)) continue;
		const fm = app.metadataCache.getFileCache(file)?.frontmatter as
			Partial<CellTypeFrontmatter> | undefined;
		if (fm?.entity_type !== "cell-type") continue;
		const layer  = (fm.layer_id     ?? "").toLowerCase();
		const region = (fm.brain_region ?? "").toLowerCase();
		if (layer === target || (!layer && region === target)) {
			result.push(file);
		}
	}
	return result;
}

/** Returns the vault-relative path of the `cells/` folder for a viewpoint
 *  note, given the layout `<viewpoints>/<slug>/<slug>.md`. */
export function cellsFolderForViewpoint(file: TFile): string {
	const parent = file.parent?.path ?? "";
	return parent ? `${parent}/cells` : "cells";
}

// ── Body parsing ──────────────────────────────────────────────────────────────

/**
 * Parses the `viewpoint` fenced JSON block from a note's raw content.
 * Returns null if the block is missing or malformed.
 */
export function parseViewpointBody(content: string): { layers: ViewpointLayer[] } | null {
	// Match: ```viewpoint  … ```
	const match = content.match(/```viewpoint\s*\n([\s\S]*?)\n```/);
	if (!match || !match[1]) return null;
	try {
		const parsed = JSON.parse(match[1]) as { layers?: ViewpointLayer[] };
		if (!Array.isArray(parsed.layers)) return null;
		return { layers: parsed.layers };
	} catch {
		return null;
	}
}

// ── Payload construction ──────────────────────────────────────────────────────

/**
 * Extracts a ViewpointPayload from a rendered Allen section SVG.
 *
 * Walks every `<path>` / element with a `structure_id` attribute that is in
 * `descendantIds` and collects its `d` + Allen metadata. The viewBox is the
 * union bbox of those elements (with a small padding).
 *
 * The passed SVG must be one that has been attached to the DOM at least once
 * so that `getBBox()` works; callers in AllenSectionViewer already do this.
 */
export function buildViewpointFromSection(
	svgEl:         SVGSVGElement,
	allenId:       number,
	parentAcronym: string,
	sectionId:     number,
	sectionOrder:  number,
	apMm:          number,
	plane:         "coronal" | "sagittal",
	descendantIds: Set<number>,
	structureTree: Map<number, AllenStructureFlat>,
): ViewpointPayload {
	const layers: ViewpointLayer[] = [];
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

	const nodes = svgEl.querySelectorAll("[structure_id]");
	for (const n of Array.from(nodes)) {
		const sid = parseInt(n.getAttribute("structure_id") ?? "", 10);
		if (!Number.isFinite(sid) || !descendantIds.has(sid)) continue;

		// Only <path> elements carry usable 'd' data; polygons are rare in Allen SVGs.
		const d = n.getAttribute("d");
		if (!d) continue;

		const node = structureTree.get(sid);
		if (!node) continue;

		layers.push({
			id:      sid,
			acronym: node.acronym,
			name:    node.name,
			color:   node.color_hex_triplet,
			d,
		});

		try {
			const b = (n as unknown as SVGGraphicsElement).getBBox();
			if (b.width > 0 || b.height > 0) {
				if (b.x < minX) minX = b.x;
				if (b.y < minY) minY = b.y;
				if (b.x + b.width  > maxX) maxX = b.x + b.width;
				if (b.y + b.height > maxY) maxY = b.y + b.height;
			}
		} catch { /* ignore un-measurable elements */ }
	}

	// Fall back to source SVG's viewBox if nothing measurable was collected.
	let view_box: string;
	if (minX < maxX && minY < maxY) {
		const padX = (maxX - minX) * 0.05;
		const padY = (maxY - minY) * 0.05;
		view_box = `${minX - padX} ${minY - padY} ${maxX - minX + padX * 2} ${maxY - minY + padY * 2}`;
	} else {
		view_box = svgEl.getAttribute("viewBox") ?? "0 0 1000 1000";
	}

	return {
		allen_id:         allenId,
		parent_region_id: parentAcronym,
		plane,
		section_id:       sectionId,
		section_order:    sectionOrder,
		ap_mm:            apMm,
		view_box,
		layers,
	};
}

// ── Note writing ──────────────────────────────────────────────────────────────

/**
 * Writes a viewpoint note. `folderRoot` is the plugin's `defaultFolder`
 * (e.g. "neuro"); the note lands in `<folderRoot>/viewpoints/`.
 * `name` is the user-facing title + filename slug seed.
 */
export async function writeViewpointNote(
	app:        App,
	folderRoot: string,
	name:       string,
	notes:      string,
	payload:    ViewpointPayload,
): Promise<TFile> {
	const viewpointsRoot = `${folderRoot}/viewpoints`;
	if (!app.vault.getFolderByPath(viewpointsRoot)) {
		await app.vault.createFolder(viewpointsRoot);
	}

	const slug = uniqueViewpointSlug(app, viewpointsRoot, slugify(name));
	const folderPath = `${viewpointsRoot}/${slug}`;
	await app.vault.createFolder(folderPath);
	await app.vault.createFolder(`${folderPath}/cells`);
	const filePath = `${folderPath}/${slug}.md`;

	const fm: ViewpointFrontmatter = {
		entity_type:      "viewpoint",
		tags:             ["viewpoint"],
		viewpoint_name:   name,
		parent_region_id: payload.parent_region_id,
		allen_id:         payload.allen_id,
		plane:            payload.plane,
		section_id:       payload.section_id,
		section_order:    payload.section_order,
		ap_mm:            payload.ap_mm,
		view_box:         payload.view_box,
		source:           "allen-ccfv3-p56",
	};

	const body =
		"```viewpoint\n" +
		JSON.stringify({ layers: payload.layers }) +
		"\n```\n";

	const notesBlock = notes.trim() ? `\n${notes.trim()}\n` : "";
	const content = `---\n${stringifyYaml(fm)}---\n\n# ${name}\n${notesBlock}\n${body}`;

	return app.vault.create(filePath, content);
}

// ── Slug helpers ──────────────────────────────────────────────────────────────

function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "") || "viewpoint";
}

function uniqueViewpointSlug(app: App, viewpointsRoot: string, base: string): string {
	let slug = base;
	let n = 2;
	while (app.vault.getAbstractFileByPath(`${viewpointsRoot}/${slug}`)) {
		slug = `${base}-${n}`;
		n++;
	}
	return slug;
}
