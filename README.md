# MapTheMind

The Obsidian plugin for neuroscientists working on the mouse brain.
MapTheMind turns your vault into a visual note-taking tool anchored
to the Allen Mouse Brain Atlas (CCFv3): browse the whole brain in 3D,
drill into Allen reference sections, and attach markdown notes to any
region, viewpoint, or cell.

## Main features

- **Visually guided note-taking across scales.** Start in a 3D whole-brain
  view, zoom into a region, pick a 2D Allen reference section, and place
  individual cell morphologies — every level is one click deep, and every
  level can hold notes.
- **True to anatomy.** All structures load from public atlases — the
  Allen Mouse Brain Atlas (CCFv3) for regions and reference sections,
  and NeuroMorpho.org for neuron morphologies.
- **Flexible note creation.** Whatever level you are looking at, create
  a markdown note from inside the plugin. Notes automatically capture
  the visual-anatomical context they were taken in and can link to
  other regions.
- **Holistic visual search.** A search bar at the bottom of the view
  surfaces notes from every nested context, so you can find what you
  wrote without remembering where you wrote it.

## Getting started

1. Open **Settings → Community plugins → Browse**, search for
   *MapTheMind*, and click **Install**, then **Enable**.
2. Click the brain icon in the ribbon (or run the command
   *Open MapTheMind view*) to open the plugin pane.
3. The 3D whole-brain view loads on first open. Click a region to
   drill in; right-click a region to create a brain-region note for it.
4. Inside a region, pick a 2D atlas section to create a viewpoint, and
   add cell-type notes to the layers you care about.

## Network usage

The plugin fetches atlas data on demand from these public APIs:

- `api.brain-map.org` — Allen Brain Atlas structure tree and section
  metadata.
- `download.alleninstitute.org` — CCFv3 structure mesh OBJs (used by
  the 3D viewer).
- `neuromorpho.org` — neuron morphologies (SWC files) for cell-type
  notes.

No telemetry is collected and no third-party analytics are loaded.
Downloads happen only when you open a region, section, or cell type
that has not yet been cached.

## Storage

Fetched atlas data and meshes are cached on disk inside the plugin
folder so subsequent loads are instant and work offline:

```
<vault>/.obsidian/plugins/neuro-mindmap-mouse/mesh-cache/
<vault>/.obsidian/plugins/neuro-mindmap-mouse/atlas-cache/
```

After extensive use the cache can grow to ~200 MB. It can be safely
deleted at any time to reclaim space — the plugin will refetch the
files it needs on next use.

## Platform

Desktop Obsidian only (v1.4.0+). Mobile support is not currently
available; the 3D viewer relies on patterns that have not yet been
adapted for touch input.

## License

GPL-3.0-only. See [LICENSE](LICENSE).
