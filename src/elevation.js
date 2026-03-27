// Elevation is intentionally stubbed for now.
// Rationale: browser-friendly public elevation APIs proved unreliable / CORS-blocked.
// Return a constant 1m value for every node so downstream 3D work can continue.

export async function fetchElevations(nodes, exaggeration = 15) {
  return new Array(nodes.length).fill(1);
}
