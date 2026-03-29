export const PRIMARY_ORIENTATION_AUTO = 'auto';

const ORIENTATION_STEPS = [0, 90, 180, 270];

export function normalizeOrientationDeg(value) {
  const normalized = Number(value);
  return ORIENTATION_STEPS.includes(normalized) ? normalized : 0;
}

export function normalizePrimaryOrientationDeg(value) {
  return value === PRIMARY_ORIENTATION_AUTO ? PRIMARY_ORIENTATION_AUTO : normalizeOrientationDeg(value);
}

export function rotatePointByOrientation(point, orientationDeg) {
  switch (normalizeOrientationDeg(orientationDeg)) {
    case 90:
      return { ...point, x: -point.y, y: point.x };
    case 180:
      return { ...point, x: -point.x, y: -point.y };
    case 270:
      return { ...point, x: point.y, y: -point.x };
    default:
      return { ...point };
  }
}

export function rotatePointsByOrientation(points, orientationDeg) {
  return (points ?? []).map(point => rotatePointByOrientation(point, orientationDeg));
}

export function rotateOutlineByOrientation(outline, orientationDeg) {
  return {
    outerRing: rotatePointsByOrientation(outline?.outerRing ?? outline ?? [], orientationDeg),
    holes: (outline?.holes ?? []).map(hole => rotatePointsByOrientation(hole, orientationDeg)),
  };
}
