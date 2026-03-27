const ELEVATION_API = 'https://api.open-elevation.com/api/v1/lookup';
const CHUNK_SIZE = 100;

export async function fetchElevations(nodes, exaggeration = 15) {
  try {
    const chunks = [];
    for (let i = 0; i < nodes.length; i += CHUNK_SIZE) {
      chunks.push(nodes.slice(i, i + CHUNK_SIZE));
    }

    const results = [];
    for (const chunk of chunks) {
      const body = JSON.stringify({
        locations: chunk.map(n => ({ latitude: n.lat, longitude: n.lon })),
      });
      const resp = await fetch(ELEVATION_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body,
      });
      if (!resp.ok) throw new Error(`open-elevation API error: ${resp.status}`);
      const data = await resp.json();
      for (const r of data.results) results.push(r.elevation);
    }

    const minElev = Math.min(...results);
    return results.map(e => (e - minElev) * exaggeration);
  } catch (err) {
    console.warn('fetchElevations failed, using flat track:', err.message);
    return new Array(nodes.length).fill(0);
  }
}
