// ──────────────────────────────────────────────────────────────────────────────
// atlas/mouseProvider.ts  —  AtlasProvider for the Allen Mouse Brain Atlas.
//
// All Mouse-specific knobs (CCFv3 graph id, mesh URL, brain-centre constants,
// reference-atlas image ids, voxel pitch) live here.  Other modules call
// `provider.fetchStructureMeshObj(id)` etc. without ever importing these
// values directly.
// ──────────────────────────────────────────────────────────────────────────────

import type { App } from "obsidian";
import {
	buildCcfToThree,
	fetchStructureMeshObj,
} from "../api/allenAtlas";
import {
	fetchAtlasSections,
	fetchSectionSvg,
	type AllenAtlasSection,
} from "../api/allenAtlas2D";
import {
	loadOrFetchStructureTree,
	type AllenStructureFlat,
} from "../api/allenStructureCache";
import type { AtlasProvider } from "./provider";

// ── Mouse CCFv3 constants ─────────────────────────────────────────────────────

const MOUSE_GRAPH_URL =
	"https://api.brain-map.org/api/v2/structure_graph_download/1.json";

const MOUSE_MESH_BASE_URL =
	"https://download.alleninstitute.org/informatics-archive/" +
	"current-release/mouse_ccf/annotation/ccf_2017/structure_meshes";

/** CCFv3 brain-centre coordinates in μm (AP, DV, ML order). */
const MOUSE_CENTRE_UM = { ap: 6600, dv: 4000, ml: 5700 } as const;

/** AP origin for ap_mm conversions — bregma in CCFv3 frame.
 *  At 25 μm resolution the volume is 528 voxels (13 200 μm) AP-extent;
 *  bregma sits ~5 400 μm from the anterior pole. */
const MOUSE_BREGMA_UM = 5400;

/** Allen P56 reference-atlas image_ids for the two reference series. */
const MOUSE_ATLAS_IDS = { coronal: 1, sagittal: 2 } as const;

/** μm per `section_number` unit — mouse reference is at 25 μm. */
const MOUSE_VOXEL_UM_PER_SECTION = 25;

/** Whole-brain root in CCFv3. */
const MOUSE_ROOT_ID = 997;

// ── Provider ──────────────────────────────────────────────────────────────────

export function createMouseProvider(app: App): AtlasProvider {
	const adapter   = app.vault.adapter;
	const baseDir   = `${app.vault.configDir}/plugins/neuro-mindmap-mouse`;
	const meshDir   = `${baseDir}/mesh-cache`;
	const atlasDir  = `${baseDir}/atlas-cache`;

	let treePromise: Promise<Map<number, AllenStructureFlat>> | null = null;
	const sectionPromises:
		Partial<Record<"coronal" | "sagittal", Promise<AllenAtlasSection[]>>> = {};

	const ccfToThree = buildCcfToThree(MOUSE_CENTRE_UM);

	return {
		brainLabel:      "Mouse Brain",
		rootStructureId: MOUSE_ROOT_ID,

		loadStructureTree() {
			if (!treePromise) {
				treePromise = loadOrFetchStructureTree(
					MOUSE_GRAPH_URL,
					meshDir,
					adapter,
				);
			}
			return treePromise;
		},

		fetchStructureMeshObj(structureId: number) {
			return fetchStructureMeshObj(structureId, MOUSE_MESH_BASE_URL);
		},
		meshCacheDir: meshDir,

		ccfToThree,
		bregmaUm:    MOUSE_BREGMA_UM,
		midlineUm:   MOUSE_CENTRE_UM.ml,
		apOriginUm:  MOUSE_CENTRE_UM.ap,

		listSections(plane) {
			let p = sectionPromises[plane];
			if (!p) {
				p = fetchAtlasSections({
					plane,
					atlasId:           MOUSE_ATLAS_IDS[plane],
					bregmaUm:          MOUSE_BREGMA_UM,
					voxelUmPerSection: MOUSE_VOXEL_UM_PER_SECTION,
					cacheDir:          atlasDir,
					adapter,
				});
				sectionPromises[plane] = p;
			}
			return p;
		},

		fetchSectionSvg(sectionId) {
			return fetchSectionSvg(sectionId, atlasDir, adapter);
		},
		atlasCacheDir: atlasDir,
	};
}
