/**
 * Public re-exports for the src/text/ module group.
 *
 * These symbols form the stable external API of the text placement pipeline.
 * Internal modules (font-loader, contours, line-breaking, scoring, placement,
 * mesh) should be imported directly only within src/text/.
 */

export { computeRankedTextPlacements } from './placement.js';
export { buildTextMeshFromRankedPlacements, TEXT_HEIGHT_MM, DEFAULT_TEXT_POSITION_RANK, normalizeTextPositionRank } from './mesh.js';
export { SCORING_WEIGHTS } from './scoring.js';
