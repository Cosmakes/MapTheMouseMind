// ──────────────────────────────────────────────────────────────────────────────
// atlas/provider.ts  —  Mouse atlas abstraction.
//
// All atlas-specific knobs (Allen CCFv3 graph id, mesh URL, brain-centre
// coordinates, voxel pitch, atlas image ids) live behind this interface so
// every view, modal, and viewpoint helper can operate on `provider.foo(…)`
// instead of importing the raw `allenAtlas` / `allenAtlas2D` modules.
//
// Concrete implementation: mouseProvider.ts.
// `getProvider(app)` returns a singleton — first call lazily loads the
// structure tree; subsequent calls reuse it.
// ──────────────────────────────────────────────────────────────────────────────

import type { AllenStructureFlat } from "../api/allenStructureCache";
import type { AllenAtlasSection } from "../api/allenAtlas2D";

export interface AtlasProvider {
	/** Human-readable label shown in the breadcrumb at depth 0
	 *  (e.g. "Mouse Brain"). */
	readonly brainLabel:      string;

	// ── Structure tree ────────────────────────────────────────────────────────

	/** Allen structure id of the whole-brain root (mouse: 997). */
	readonly rootStructureId: number;

	/** Loads the structure tree on first call; cached to disk and to memory. */
	loadStructureTree(): Promise<Map<number, AllenStructureFlat>>;

	// ── 3D meshes ─────────────────────────────────────────────────────────────

	/** Returns the raw OBJ text for a structure mesh. */
	fetchStructureMeshObj(structureId: number): Promise<string>;

	/** Vault directory where structure OBJs are cached. */
	readonly meshCacheDir: string;

	// ── Coordinate frame ──────────────────────────────────────────────────────

	/** Converts an atlas vertex (μm, Allen-axis-order) to the Three.js space
	 *  used by BrainViewer3D — right-hand, Y-up, brain centred at origin,
	 *  1 unit = 1 mm. */
	ccfToThree(x: number, y: number, z: number): [number, number, number];

	/** AP origin used to convert section index ↔ ap_mm — CCFv3 bregma 5400 μm. */
	readonly bregmaUm:    number;

	/** ML midline coordinate, used for hemisphere split. */
	readonly midlineUm:   number;

	/** AP coordinate of the brain centre in atlas frame, used to anchor
	 *  sagittal section positioning. */
	readonly apOriginUm:  number;

	// ── 2D sections ───────────────────────────────────────────────────────────

	/** Returns the ordered list of reference-atlas sections for one plane.
	 *  Cached on disk under `atlasCacheDir`. */
	listSections(plane: "coronal" | "sagittal"): Promise<AllenAtlasSection[]>;

	/** Returns SVG markup for a single section image. Cached under
	 *  `${atlasCacheDir}/svg/{sectionId}.svg`. */
	fetchSectionSvg(sectionId: number): Promise<string>;

	/** Vault directory where 2D atlas data (section list, individual SVGs,
	 *  structure-section indexes) is cached. */
	readonly atlasCacheDir: string;
}
