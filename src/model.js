import OpenCascade from 'opencascade.js/dist/opencascade.wasm.js';
import openCascadeWasmUrl from 'opencascade.js/dist/opencascade.wasm.wasm?url';

const BASE_THICKNESS_MM = 8;
const TRACK_HEIGHT_MM = 2;

let occtPromise = null;
let occtInstance = null;

export async function loadOcct() {
  if (!occtPromise) {
    occtPromise = (async () => {
      occtInstance = await new OpenCascade({
        locateFile(path) {
          if (path.endsWith('.wasm')) {
            return openCascadeWasmUrl;
          }

          return path;
        },
      });

      return occtInstance;
    })().catch(error => {
      occtPromise = null;
      occtInstance = null;
      throw error;
    });
  }

  return occtPromise;
}

function toMm(valueMetres) {
  return valueMetres * 1000;
}

function normalizeRing(points) {
  if (!Array.isArray(points) || points.length < 3) {
    throw new Error('Outline must contain at least three points');
  }

  const ring = [];

  for (const point of points) {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
      continue;
    }

    const previous = ring[ring.length - 1];
    if (previous && previous.x === point.x && previous.y === point.y) {
      continue;
    }

    ring.push({ x: point.x, y: point.y });
  }

  if (ring.length < 3) {
    throw new Error('Outline must contain at least three unique points');
  }

  const first = ring[0];
  const last = ring[ring.length - 1];

  if (first.x === last.x && first.y === last.y) {
    ring.pop();
  }

  return ring;
}

function makePolygonWire(oc, points, z) {
  const polygon = new oc.BRepBuilderAPI_MakePolygon_1();

  for (const point of points) {
    polygon.Add_1(new oc.gp_Pnt_3(toMm(point.x), toMm(point.y), z));
  }

  polygon.Close();

  if (!polygon.IsDone()) {
    throw new Error('Failed to build track outline wire');
  }

  return polygon.Wire();
}

function makeTrackSolid(oc, outlinePoints) {
  const ring = normalizeRing(outlinePoints);
  const wire = makePolygonWire(oc, ring, BASE_THICKNESS_MM);
  const faceMaker = new oc.BRepBuilderAPI_MakeFace_15(wire, false);

  if (!faceMaker.IsDone()) {
    throw new Error('Failed to build track face');
  }

  const prism = new oc.BRepPrimAPI_MakePrism_1(
    faceMaker.Face(),
    new oc.gp_Vec_4(0, 0, TRACK_HEIGHT_MM),
    false,
    true,
  );

  if (!prism.IsDone()) {
    throw new Error('Failed to extrude track solid');
  }

  return prism.Shape();
}

function makeBaseSlab(oc, basePlate) {
  return new oc.BRepPrimAPI_MakeBox_2(
    new oc.gp_Pnt_3(toMm(basePlate.minX), toMm(basePlate.minY), 0),
    toMm(basePlate.width),
    toMm(basePlate.height),
    BASE_THICKNESS_MM,
  ).Shape();
}

function makeCompound(oc, shapes) {
  const builder = new oc.BRep_Builder();
  const compound = new oc.TopoDS_Compound();
  builder.MakeCompound(compound);

  for (const shape of shapes) {
    builder.Add(compound, shape);
  }

  return compound;
}

function fuseShapesIfAvailable(oc, baseShape, trackShape) {
  if (!oc.BRepAlgoAPI_Fuse_3) {
    return null;
  }

  try {
    const fuse = new oc.BRepAlgoAPI_Fuse_3(baseShape, trackShape);

    if (typeof fuse.Build === 'function') {
      fuse.Build();
    }

    if (typeof fuse.IsDone === 'function' && !fuse.IsDone()) {
      return null;
    }

    return fuse.Shape();
  } catch {
    return null;
  }
}

export function buildTrackModel({ outlinePoints, basePlate, trackName }) {
  const oc = occtInstance;
  if (!oc) {
    throw new Error('OpenCascade is not loaded');
  }

  if (!basePlate) {
    throw new Error('Base plate dimensions are missing');
  }

  const baseShape = makeBaseSlab(oc, basePlate);
  const trackShape = makeTrackSolid(oc, outlinePoints);
  const fused = fuseShapesIfAvailable(oc, baseShape, trackShape);
  const shape = fused || makeCompound(oc, [baseShape, trackShape]);

  // TODO(issue #4): add raised text once the basic export path is stable.
  void trackName;

  return shape;
}

function isReturnStatus(status, expected) {
  return status === expected;
}

export function exportStep(shape, fileName = 'racetrack.step') {
  const oc = occtInstance;
  if (!oc) {
    throw new Error('OpenCascade is not loaded');
  }

  const normalizedBase = String(fileName)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || 'racetrack';
  const downloadFileName = normalizedBase.endsWith('.step') ? normalizedBase : `${normalizedBase}.step`;

  // Use a fixed simple virtual filename for OpenCascade/Emscripten FS.
  // The user-friendly filename is only used for the browser download.
  const virtualFileName = 'out.step';
  const candidatePaths = [virtualFileName, `/${virtualFileName}`];

  for (const path of candidatePaths) {
    try {
      oc.FS.unlink(path);
    } catch {
      // File may not exist from a previous export.
    }
  }

  const writer = new oc.STEPControl_Writer_1();
  const transferStatus = writer.Transfer(shape, oc.STEPControl_StepModelType.STEPControl_AsIs, true);
  const writeStatus = writer.Write(virtualFileName);

  if (!isReturnStatus(transferStatus, oc.IFSelect_ReturnStatus.IFSelect_RetDone)) {
    throw new Error('STEP transfer failed');
  }

  if (!isReturnStatus(writeStatus, oc.IFSelect_ReturnStatus.IFSelect_RetDone)) {
    throw new Error('STEP write failed');
  }

  let stepBytes = null;
  for (const path of candidatePaths) {
    try {
      stepBytes = oc.FS.readFile(path);
      break;
    } catch {
      // try next candidate path
    }
  }

  if (!stepBytes) {
    let rootEntries = [];
    try {
      rootEntries = oc.FS.readdir('/');
    } catch {
      // ignore
    }
    throw new Error(`FS error: STEP file not found after write. FS / = ${rootEntries.join(', ')}`);
  }

  const blob = new Blob([stepBytes], { type: 'model/step' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = downloadFileName;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);

  return { fileName: downloadFileName };
}
