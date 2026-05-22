// ──────────────────────────────────────────────────────────────────────────────
// api/allenAtlas2D.ts  —  Allen Mouse Brain Atlas 2D section data.
//
// Provides:
//   fetchAtlasSections()   — ordered list of atlas image IDs for one plane,
//                            with AP positions; cached as JSON.
//   fetchSectionSvg()      — SVG outline data for one atlas section; cached
//                            as an SVG file.
//   findSectionsForStructure() — index of which sections show the structure.
//
// ──────────────────────────────────────────────────────────────────────────────

import { requestUrl } from "obsidian";
import type { DataAdapter } from "obsidian";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AllenAtlasSection {
	/** Allen atlas image ID — used in svg_download calls. */
	id: number;
	/** 0-based index in the anterior→posterior ordered list. */
	order: number;
	/**
	 * Approximate AP position in mm relative to the atlas's reference origin
	 * (mouse: bregma).  Positive = anterior, negative = posterior.
	 */
	apPositionMm: number;
}

// Raw API response shapes
interface ApiAtlasImage {
	id: number;
	section_number?: number;
}

interface ApiQueryResponse {
	success: boolean;
	msg: ApiAtlasImage[];
}

// ── Section list ──────────────────────────────────────────────────────────────

export interface FetchAtlasSectionsOpts {
	plane:        "coronal" | "sagittal";
	/** Allen atlas_id of the reference series for `plane` (mouse coronal = 1). */
	atlasId:      number;
	/** AP origin in μm — section AP is reported relative to this. */
	bregmaUm:     number;
	/** μm per section_number unit (mouse 25 μm; human reference is coarser). */
	voxelUmPerSection: number;
	cacheDir:     string;
	adapter:      DataAdapter;
}

/**
 * Fetches the ordered list of reference-atlas sections for one plane.
 * Cached as `${cacheDir}/sections-${plane}-v2.json`.
 */
export async function fetchAtlasSections(
	opts: FetchAtlasSectionsOpts,
): Promise<AllenAtlasSection[]> {
	const { plane, atlasId, bregmaUm, voxelUmPerSection, cacheDir, adapter } = opts;
	try { await adapter.mkdir(cacheDir); } catch { /* already exists */ }

	const cachePath = `${cacheDir}/sections-${plane}-v2.json`;
	if (await adapter.exists(cachePath)) {
		try {
			const raw = await adapter.read(cachePath);
			return JSON.parse(raw) as AllenAtlasSection[];
		} catch {
			// Corrupt cache — fall through to re-fetch.
		}
	}

	// AtlasImage has no direct atlas_id; join via atlas_data_set(atlases[id$eqN]).
	// [annotated$eqtrue] narrows to the canonical reference plates that actually
	// carry structure annotations in svg_download.
	const url =
		`https://api.brain-map.org/api/v2/data/query.json?` +
		`criteria=model::AtlasImage,rma::criteria,` +
		`[annotated$eqtrue],atlas_data_set(atlases[id$eq${atlasId}]),` +
		`rma::options[order$eq'sub_images.section_number'][num_rows$eq500]`;

	const res  = await requestUrl({ url });
	const body = res.json as ApiQueryResponse;

	if (!body.success || !Array.isArray(body.msg)) {
		throw new Error("[neuro-mindmap] Atlas section list query failed");
	}

	const sections: AllenAtlasSection[] = body.msg.map((img, i) => {
		// section_number interpretation: typically given in voxel units, so
		// multiply by voxelUmPerSection.  Some atlases return μm directly when
		// the value is large — heuristic: > 600 means "already μm".
		const sn   = img.section_number ?? (i + 1);
		const apUm = sn <= 600 ? sn * voxelUmPerSection : sn;
		return {
			id:           img.id,
			order:        i,
			apPositionMm: (bregmaUm - apUm) / 1000,
		};
	});

	await adapter.write(cachePath, JSON.stringify(sections));
	return sections;
}

// ── SVG for one section ───────────────────────────────────────────────────────

/**
 * Returns the SVG markup for a single atlas image.
 * Cached as `${cacheDir}/svg/{imageId}.svg`.
 */
export async function fetchSectionSvg(
	imageId:  number,
	cacheDir: string,
	adapter:  DataAdapter,
): Promise<string> {
	const svgDir   = `${cacheDir}/svg`;
	const cachePath = `${svgDir}/${imageId}.svg`;

	try { await adapter.mkdir(svgDir); } catch { /* already exists */ }

	if (await adapter.exists(cachePath)) {
		return adapter.read(cachePath);
	}

	const url = `https://api.brain-map.org/api/v2/svg_download/${imageId}`;
	const res  = await requestUrl({ url });
	const text = res.text;

	await adapter.write(cachePath, text);
	return text;
}

// ── Nearest section lookup ────────────────────────────────────────────────────

// ── Structure-to-section index ────────────────────────────────────────────────

/**
 * Finds the indices (into `sections`) of all sections that contain a visible
 * SVG path for the given structure — matched against ANY descendant, since
 * Allen reference-atlas SVGs only annotate leaves (e.g. CA1 itself is never
 * drawn; CA1sp/CA1so/CA1sr/CA1slm are).
 *
 * `descendantIds` must include the target ID plus all transitive descendants
 * (see `getDescendantIds` in allenStructureCache).
 *
 * Cached as `${cacheDir}/structure-sections-{structureId}-{plane}-v2.json`.
 * The caller pre-fetches a window of SVGs before invoking this; an empty
 * result is not persisted so a later run with a wider cache re-scans.
 */
export async function findSectionsForStructure(
	structureId:   number,
	plane:         "coronal" | "sagittal",
	sections:      AllenAtlasSection[],
	cacheDir:      string,
	adapter:       DataAdapter,
	descendantIds: Set<number>,
): Promise<number[]> {
	const indexPath = `${cacheDir}/structure-sections-${structureId}-${plane}-v2.json`;

	if (await adapter.exists(indexPath)) {
		try {
			const cached = JSON.parse(await adapter.read(indexPath)) as number[];
			if (cached.length > 0) return cached;
		} catch {
			// Corrupt cache — rebuild.
		}
	}

	const svgDir = `${cacheDir}/svg`;
	const tags   = Array.from(descendantIds, id => `structure_id="${id}"`);
	const found: number[] = [];

	for (let i = 0; i < sections.length; i++) {
		const section = sections[i];
		if (!section) continue;
		const svgPath = `${svgDir}/${section.id}.svg`;
		if (!(await adapter.exists(svgPath))) continue;
		try {
			const svg = await adapter.read(svgPath);
			for (const tag of tags) {
				if (svg.includes(tag)) { found.push(i); break; }
			}
		} catch {
			// Skip unreadable files.
		}
	}

	if (found.length > 0) {
		await adapter.write(indexPath, JSON.stringify(found));
	}
	return found;
}
