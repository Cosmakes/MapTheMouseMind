// ──────────────────────────────────────────────────────────────────────────────
// api/allenAtlas.ts  —  Allen Mouse Brain Atlas API client.
//
//   Structure ontology (JSON tree):
//     https://api.brain-map.org/api/v2/structure_graph_download/{graph_id}.json
//
//   3D mesh files (OBJ, μm coordinates):
//     <meshBaseUrl>/{structure_id}.obj
//
// Coordinate conversion to Three.js (right-hand, Y-up, brain centred at
// origin, 1 unit = 1 mm) is done by the factory `buildCcfToThree(centreUm)`
// where `centreUm` is the (AP, DV, ML) brain-centre in the atlas's μm frame.
// ──────────────────────────────────────────────────────────────────────────────

import { requestUrl } from "obsidian";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface AllenStructure {
	id: number;
	name: string;
	acronym: string;
	/** 6-char hex without '#', e.g. "70FF71" */
	color_hex_triplet: string;
	parent_structure_id: number | null;
	st_level: number;
	children: AllenStructure[];
}

// ── API calls ──────────────────────────────────────────────────────────────────

/**
 * Fetches the complete flat list of all structures (~1300 nodes for mouse) by
 * recursively traversing the nested tree returned by the API.
 * Falls back to [] on network failure.
*/
export async function fetchFullStructureTree(graphUrl: string): Promise<AllenStructure[]> {
	try {
		const res  = await requestUrl({ url: graphUrl });
		const body = res.json as { msg: AllenStructure[] };
		const root = body.msg?.[0];
		if (!root) return [];
		const flat: AllenStructure[] = [];
		const walk = (node: AllenStructure): void => {
			flat.push(node);
			node.children.forEach(walk);
		};
		walk(root);
		return flat;
	} catch (err) {
		console.warn("[neuro-mindmap] Allen structure API unavailable:", err);
		return [];
	}
}

/**
 * Downloads the OBJ mesh for a given structure ID.  Throws on network error.
 *
 * `meshBaseUrl` is provider-supplied:
 *   mouse → …/mouse_ccf/annotation/ccf_2017/structure_meshes
*/
export async function fetchStructureMeshObj(
	structureId: number,
	meshBaseUrl: string,
): Promise<string> {
	const url = `${meshBaseUrl}/${structureId}.obj`;
	const res = await requestUrl({ url });
	return res.text;
}

// ── Coordinate transform ───────────────────────────────────────────────────────

/** Three-axis brain centre in atlas μm frame, in CCF axis order
 *  (AP, DV, ML — i.e. OBJ vertex order x, y, z). */
export interface AtlasCentreUm {
	ap: number;  // CCF x
	dv: number;  // CCF y
	ml: number;  // CCF z
}

/**
 * Returns a `ccfToThree(x, y, z)` function bound to the mouse brain
 * centre. The returned closure does the per-vertex math used by
 * BrainViewer3D.
 *
 * Three.js axes:
 *   X = ML  (right hemisphere = +X)
 *   Y = DV  (dorsal = +Y, inverted from CCF y)
 *   Z = AP  (anterior = +Z, inverted from CCF x)
 */
export function buildCcfToThree(
	centre: AtlasCentreUm,
	umPerThreeUnit = 1000,
): (x: number, y: number, z: number) => [number, number, number] {
	const k = umPerThreeUnit;
	return (objX, objY, objZ) => [
		 (objZ - centre.ml) / k,
		-(objY - centre.dv) / k,
		-(objX - centre.ap) / k,
	];
}
