// ──────────────────────────────────────────────────────────────────────────────
// api/morphologySource.ts  —  Abstraction over morphology databases.
//
// A `MorphologySource` searches some external DB (NeuroMorpho.org, Allen Cell
// Types, etc.) for neurons reconstructed in a given Allen leaf. The UI code
// in AddCellModal is source-agnostic: it iterates whatever sources are
// registered in `getMorphologySources()` and aggregates their candidates.
// ──────────────────────────────────────────────────────────────────────────────

export interface MorphologyCandidate {
	/** Stable identifier usable as CellTypeFrontmatter.morphology_source,
	 *  e.g. "neuromorpho:cnic_001". */
	identifier:  string;
	name:        string;
	/** Free-text cell type as reported by the source DB (may be ""). */
	cellType:    string;
	/** Source-reported brain region string — for UX only, not matching. */
	brainRegion: string;
	species:     string;
	/** "NeuroMorpho.org" | "Allen Cell Types" | … — shown as a badge. */
	source:      string;
	/** Optional extra fields (archive, strain, reconstruction tool, …). */
	extra?:      Record<string, string>;
}

export interface MorphologyQuery {
	/** Allen leaf acronym the user has focused, e.g. "CA1sp" — used for layer-hint
	 *  re-ranking only, not as a query term. */
	leafAcronym:   string;
	/** Allen leaf full name, e.g. "Field CA1, pyramidal layer". Display only. */
	leafName:      string;
	/** Allen acronym to actually query NeuroMorpho with. AddCellModal walks up
	 *  the Allen tree (leaf → parent → grandparent → …) until something hits. */
	regionAcronym: string;
	/** Species filter passed through to NeuroMorpho's `species` criterion. */
	species:       "mouse";
}

export interface MorphologySource {
	id:    string;
	label: string;
	search(query: MorphologyQuery): Promise<MorphologyCandidate[]>;
}
