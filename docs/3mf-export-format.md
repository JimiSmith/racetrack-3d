# 3MF export format

This note documents the structure of the `.3mf` files produced by
`src/export/threemf.ts` (`build3mfModelXml` / `package3mf` / `export3mf`). It is
the canonical spec for the export markup; if you change the writer, update this
doc to match.

## Package layout

The `.3mf` is an OPC zip (built with `fflate.zipSync`) containing:

- `[Content_Types].xml`
- `_rels/.rels` — relationship pointing at the model part
- `3D/3dmodel.model` — the model XML described below

## Model structure: one printable, many parts

The model is a **single printable object** assembled from several mesh parts:

- A **single parent `<object type="model">`** holds a `<components>` list and
  carries **no `<mesh>`** of its own — it is a pure container.
- Each logical part (base plate, secondary track, primary track + text) is a
  **separate mesh `<object>`** with **its own vertex pool**. Keeping each part's
  mesh independent is what preserves per-part 2-manifoldness: coplanar
  boundaries that live in different parts (e.g. flush coaster pocket walls vs.
  inlay walls) cannot merge into edges incident to four faces.
- Exactly **one `<build><item>`**, referencing the parent object.

The mesh objects (children) are declared in `<resources>` **before** the parent
object that references them. PrusaSlicer requires children to precede the parent
that references them; the writer's fixed part add order (base, secondary, track)
guarantees this. Object ids start at `2` (id `1` is reserved for the colorgroup);
the parent is allocated the next free id after all children.

`<component>`s use no transform — the meshes are already in final coordinates
(identity transform).

### Example

```xml
<model unit="millimeter" xml:lang="en-US"
  xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
  xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">
  <resources>
    <m:colorgroup id="1">
      <m:color color="#000000"/>
      <m:color color="#E8002D"/>
      <m:color color="#888888"/>
    </m:colorgroup>
    <object id="2" type="model">
      <mesh>
        <vertices>...</vertices>
        <triangles>
          <triangle v1="..." v2="..." v3="..." pid="1" p1="0"/>
        </triangles>
      </mesh>
    </object>
    <object id="3" type="model">
      <mesh>...<triangle ... pid="1" p1="1"/>...</mesh>
    </object>
    <object id="4" type="model">
      <components>
        <component objectid="2"/>
        <component objectid="3"/>
      </components>
    </object>
  </resources>
  <build>
    <item objectid="4"/>
  </build>
</model>
```

In this example the secondary track is empty (the common case), so only base
(id 2) and track (id 3) mesh objects exist; the parent is id 4 with two
components, and the single build item references id 4. When a secondary track is
present there are three mesh objects (ids 2, 3, 4) and the parent is id 5.

If the model has no parts at all (degenerate, zero triangles), no parent object
and no build item are emitted — the model XML is otherwise valid with an empty
`<build>`.

## Colour: one scheme

There is **one colour scheme**: a single `<m:colorgroup id="1">` plus a
**per-triangle** `pid="1" p1="N"` on every `<triangle>`. There is **no
per-object `pindex`** — the previous redundant per-object colour attribute has
been removed. Per-triangle colour is what survives a future mixed-colour part.

Palette (colorgroup entries, in order) and index mapping:

| `p1` | meaning                         | colour        |
|------|---------------------------------|---------------|
| 0    | base plate                      | black #000000 |
| 1    | primary track + embossed text   | red #E8002D   |
| 2    | secondary track                 | grey #888888  |

**Add-order is NOT colour-index — and that is intentional.** The writer adds
parts in the order base, secondary, track (which fixes object ids and the
children-before-parent declaration order), but the colour index is fixed per
part type: base = 0, track + text = 1, secondary = 2. A future reader should not
"fix" this apparent mismatch; the two orderings are deliberately decoupled.

## Namespaces

- Core: `http://schemas.microsoft.com/3dmanufacturing/core/2015/02` (default `xmlns`)
- Material: `http://schemas.microsoft.com/3dmanufacturing/material/2015/02` (`xmlns:m`),
  used for `<m:colorgroup>` / `<m:color>` and the per-triangle `p1`.

`<components>` is part of the core spec and needs no extra namespace.

## Slicer support

- **Bambu Studio** is the validated, solid path: the model loads as one
  printable (auto-arrange treats it as a single object), and colours render
  correctly — base black, primary track + text red, secondary grey.
- **PrusaSlicer / Cura** are **best-effort and currently UNTESTED** (no test
  environment). The single-object + components idiom is what these slicers
  expect for one printable, so the geometry should import as one object. However
  colour-extension support varies: PrusaSlicer/Cura may render colours
  differently, or may prefer `basematerials` over the colorgroup material
  extension. **Cross-slicer colour is unverified.** Validating colour in
  PrusaSlicer and Cura is tracked as a follow-up.

## Migration note for downstream 3MF parsers

The previous layout emitted **N top-level mesh `<object>`s, each with its own
`<build><item>`**. The current layout emits **one parent `<object>` whose
`<components>` list references the N mesh objects, with a single
`<build><item>`** pointing at the parent. Downstream parsers must iterate the
parent's `<components>` to enumerate the parts — do not assume one top-level
object per part, and do not assume one build item per part.
