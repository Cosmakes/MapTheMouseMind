// ──────────────────────────────────────────────────────────────────────────────
// types.ts  —  Central type definitions for every note schema and view concept.
// ──────────────────────────────────────────────────────────────────────────────

// ── Connection schema ──────────────────────────────────────────────────────────
//
// Notes can declare typed connections to other brain regions (or future cell
// types / phenomena).  These are stored in a `region_connections` frontmatter
// list and will be visualised as overlay arrows in the 2D slice viewer once
// Phase 2 of the connection system is implemented.

export type ConnectionDirection =
	| "afferent"      // input TO this region / cell
	| "efferent"      // output FROM this region / cell
	| "bidirectional" // bidirectional connection
	| "modulatory";   // neuromodulatory influence (no net direction)

export interface RegionConnection {
	/** region_id of the connected brain region. */
	target_id: string;
	direction:  ConnectionDirection;
	/** Named pathway, e.g. "Schaffer collateral", "Perforant path". */
	pathway?:   string;
	/** Citation or DOI for the evidence supporting this connection. */
	evidence?:  string;
}

// ── Cell compartments ─────────────────────────────────────────────────────────
//
// Mirrors the SWC node-type taxonomy used in NeuroMorpho files:
//   1 = soma, 2 = axon, 3 = basal dendrite, 4 = apical dendrite.
// "dendrite" is a convenience grouping (basal ∪ apical) used by renderer
// filters and frontmatter scopes that don't need to distinguish the two.

export type Compartment = "soma" | "axon" | "basal" | "apical" | "dendrite";

// ── Cell-type note frontmatter ─────────────────────────────────────────────────

export type CellClass =
	| "pyramidal"
	| "interneuron"
	| "granule"
	| "glial"
	| "other";

/**
 * YAML frontmatter for `neuro/cells/*.md` notes.
 * Required: entity_type, cell_name, cell_class, brain_region.
 */
export interface CellTypeFrontmatter {
	entity_type: "cell-type";
	tags: string[];
	cell_name: string;
	cell_class: CellClass;
	brain_region: string;
	/** Maps to a RegionLayer.id in schematics.ts — used to colour cell body dots. */
	layer_id?: string;
	neurotransmitter?: string;
	ontology_id?: string;
	/** Acronyms of leaf layers where dendrites arborize, e.g. ["CA1slm","CA1sr"]. */
	dendrite_layers?: string[];
	/** Acronyms of leaf layers where axons project. */
	axon_layers?: string[];
	/** Morphology source reference — "neuromorpho:<name>" to fetch real SWC. */
	morphology_source?: string;
	/** Per-viewpoint placement overrides. Key = viewpoint file basename. When
	 *  absent for a given viewpoint, the renderer falls back to layer-centroid
	 *  + auto-spread placement. */
	placements?: Record<string, Placement>;
}

/** User-controlled placement of a cell within one viewpoint's coordinate space. */
export interface Placement {
	x:        number;  // viewBox coord (cx of the soma)
	y:        number;  // viewBox coord (cy of the soma)
	scale:    number;  // multiplier on the auto-fit morphology size; 1 = default
	rotation: number;  // degrees, clockwise around (x, y)
}

// ── Connection note frontmatter ───────────────────────────────────────────────
//
// Notes that represent a connection between two anatomical entities.
// entity_type: connection → neuro/connections/<source>-<target>.md

export interface ConnectionFrontmatter {
	entity_type: "connection";
	tags: string[];
	/** region_id or layer_id of the source entity. */
	source: string;
	/** region_id or layer_id of the target entity. */
	target: string;
	/** Human-readable description, e.g. "theta-gamma coupling via mossy fibers". */
	label?: string;
	direction?: ConnectionDirection;
	strength?: "strong" | "moderate" | "weak";
}

// ── Brain-region note frontmatter ──────────────────────────────────────────────

/**
 * YAML frontmatter for brain-region notes (both major regions and subregions).
 * The `region_id` matches the ID used in atlas SVG regions for visual lookup.
 * `allen_id` is the primary key for all Allen CCFv3 API lookups; when present it
 * supersedes the legacy region_id for mesh and section image fetching.
 */
export interface BrainRegionFrontmatter {
	entity_type: "brain-region";
	tags: string[];
	region_name: string;
	region_id: string;           // e.g. "hippocampus", "CA1", "frontal-cortex"
	parent_region?: string;      // e.g. "mouse-brain", "hippocampus"
	ontology_id?: string;
	/** Allen CCFv3 structure ID — primary key for mesh and section image API lookups. */
	allen_id?: number;
	/** Allen IDs of ancestor structures ordered root-last, used to load context meshes. */
	allen_ancestor_ids?: number[];
	/** Typed connections to other brain regions; visualised as arrows in Phase 2. */
	region_connections?: RegionConnection[];
}

// ── Viewpoint note frontmatter ────────────────────────────────────────────────
//
// A `viewpoint` is a schematic 2D representation of a single Allen atlas slice
// restricted to one brain structure, with its subregions drawn and labeled.
// Generated from the Allen section viewer when the user picks a slice; stored
// as `neuro/viewpoints/<slug>.md` with metadata in frontmatter and polygon data
// in a fenced `viewpoint` code block in the note body (JSON — too large for YAML).

/** One labeled polygon in a viewpoint — the SVG path for one Allen leaf descendant. */
export interface ViewpointLayer {
	/** Allen CCFv3 structure ID of the leaf. */
	id: number;
	acronym: string;
	name: string;
	/** 6-char hex color without '#', from Allen `color_hex_triplet`. */
	color: string;
	/** SVG path 'd' attribute — polygon geometry in the source section's coordinate system. */
	d: string;
}

export interface ViewpointFrontmatter {
	entity_type: "viewpoint";
	tags: string[];
	viewpoint_name: string;
	/** region_id of the parent brain region (matches BrainRegionFrontmatter.region_id). */
	parent_region_id: string;
	/** Allen structure ID of the parent — primary key for picker lookup. */
	allen_id: number;
	plane: "coronal" | "sagittal";
	/** Allen atlas image ID of the source section. */
	section_id: number;
	/** 0-based index in sections-{plane}-v2.json. */
	section_order: number;
	/** AP position relative to bregma, in mm. */
	ap_mm: number;
	/** SVG viewBox for the generated schematic, e.g. "5000 2800 3400 2200". */
	view_box: string;
	/** Provenance tag for the source atlas. */
	source: "allen-ccfv3-p56";
	/** Persisted rotation of the viewpoint canvas in degrees, clockwise.
	 *  Applied as an SVG transform around the viewBox centre. */
	view_rotation?: number;
}

// ── Topic & theme note frontmatter ────────────────────────────────────────────
//
// Atomic-notes model for paper-reading:
//   - A `topic` captures one concept (mechanism / circuit / phenomenon).
//   - `scope` anchors the topic to anatomical entities so the viewpoint
//     side panel can surface it in the right place.
//   - `related` holds typed links to other topic notes (mechanism_of,
//     input_to, …) — lightweight ontology, not a rigid schema.
//   - `themes` are cross-cutting tags that are themselves notes (so a
//     theme page collects every topic tagged with it via backlinks).

export type RelationKind =
	| "mechanism_of"
	| "input_to"
	| "output_of"
	| "part_of"
	| "evidence_for"
	| "contradicts"
	| "related";

export interface TopicRelation {
	kind: RelationKind;
	/** Wikilink target — note basename without extension. */
	note: string;
	/** Optional human-readable label if different from basename. */
	note_text?: string;
}

export interface TopicScope {
	/** Allen structure ID — anchors this topic to a region/subregion. */
	allen_id?: number;
	/** Cell-type note basename — anchors topic to a specific cell. */
	cell?: string;
	/** Optional cell compartment — narrows a `cell`-scoped topic to one
	 *  part of the morphology (soma, axon, basal/apical dendrite). */
	compartment?: Compartment;
}

/**
 * YAML frontmatter for `neuro/topics/*.md` — one atomic concept note.
 * `scope: []` means the topic is unscoped / applies broadly.
 */
export interface TopicFrontmatter {
	entity_type: "topic";
	tags: string[];
	topic_name: string;
	summary?: string;
	scope: TopicScope[];
	themes?: string[];
	related?: TopicRelation[];
	/** Where the note was taken — used to scope search results. Notes
	 *  without `level` are treated as `brain` for backward compatibility. */
	level?: "brain" | "viewpoint" | "cell";
	/** Slug of the viewpoint this note was taken in (level: viewpoint | cell). */
	viewpoint_id?: string;
	/** Slug of the cell this note was taken in (level: cell). */
	cell_id?: string;
}
