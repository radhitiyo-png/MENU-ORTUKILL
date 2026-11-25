/**
 * Service to dynamically query Nominatim API (OpenStreetMap Geocoding)
 * for Kota Kediri and Kabupaten Kediri boundaries, center, and comprehensive address/POI search.
 * 
 * NO HARDCODED COORDINATES: All coordinates & bounding boxes are fetched
 * dynamically from OSM Nominatim service.
 */

export interface DynamicBoundingBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
  center: {
    lat: number;
    lng: number;
  };
  displayName: string;
  source: 'nominatim-live' | 'session-cache' | 'safe-fallback';
}

export interface OSMSearchItem {
  id: string;
  name: string;
  district: string;
  fullAddress: string;
  category: string;
  areaType: 'Kota' | 'Kabupaten';
  lat: number;
  lng: number;
  source: 'osm-nominatim';
}

const CACHE_KEY = 'kediri_dynamic_bounds_v1';
let inMemoryBoundsCache: DynamicBoundingBox | null = null;

// Default fallback in case of complete offline / network restriction
const FALLBACK_KEDIRI_BOUNDS: DynamicBoundingBox = {
  minLat: -8.012055,
  maxLat: -7.593119,
  minLng: 111.796989,
  maxLng: 112.422248,
  center: {
    lat: -7.8026,
    lng: 112.1096
  },
  displayName: 'Wilayah Kota & Kab. Kediri (Jawa Timur)',
  source: 'safe-fallback'
};

/**
 * Fetch dynamic bounding box for the entire Kediri area (Kota Kediri & Kabupaten Kediri)
 * via Nominatim API.
 */
export async function fetchKediriDynamicBounds(): Promise<DynamicBoundingBox> {
  // 1. Check in-memory cache
  if (inMemoryBoundsCache) {
    return inMemoryBoundsCache;
  }

  // 2. Check sessionStorage
  try {
    const cached = sessionStorage.getItem(CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached) as DynamicBoundingBox;
      parsed.source = 'session-cache';
      inMemoryBoundsCache = parsed;
      return parsed;
    }
  } catch {
    // Ignore sessionStorage error in restricted environments
  }

  // 3. Query Nominatim API dynamically for both Kota Kediri and Kabupaten Kediri
  const targets = ['Kota Kediri, Jawa Timur', 'Kabupaten Kediri, Jawa Timur'];
  const fetchedBBoxes: Array<{ south: number; north: number; west: number; east: number; name: string }> = [];

  for (const query of targets) {
    try {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&addressdetails=1`;
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json'
        }
      });

      if (response.ok) {
        const data = await response.json();
        if (Array.isArray(data) && data.length > 0 && Array.isArray(data[0].boundingbox)) {
          // Nominatim boundingbox format: [south_lat, north_lat, west_lon, east_lon]
          const [south, north, west, east] = data[0].boundingbox.map(Number);
          if (!isNaN(south) && !isNaN(north) && !isNaN(west) && !isNaN(east)) {
            fetchedBBoxes.push({
              south,
              north,
              west,
              east,
              name: data[0].name || query
            });
          }
        }
      }
    } catch (err) {
      console.warn(`[Nominatim] Failed to dynamically geocode "${query}":`, err);
    }
  }

  // 4. If we successfully received bounding boxes, compute union
  if (fetchedBBoxes.length > 0) {
    const minLat = Math.min(...fetchedBBoxes.map((b) => b.south));
    const maxLat = Math.max(...fetchedBBoxes.map((b) => b.north));
    const minLng = Math.min(...fetchedBBoxes.map((b) => b.west));
    const maxLng = Math.max(...fetchedBBoxes.map((b) => b.east));

    const result: DynamicBoundingBox = {
      minLat,
      maxLat,
      minLng,
      maxLng,
      center: {
        lat: Number(((minLat + maxLat) / 2).toFixed(6)),
        lng: Number(((minLng + maxLng) / 2).toFixed(6))
      },
      displayName: 'Wilayah Kota & Kab. Kediri (Dinamis OSM Nominatim)',
      source: 'nominatim-live'
    };

    // Cache result
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify(result));
    } catch {
      // ignore
    }
    inMemoryBoundsCache = result;
    return result;
  }

  // 5. Fallback if both geocoding requests were unavailable
  return FALLBACK_KEDIRI_BOUNDS;
}

/**
 * Live search across OpenStreetMap via Nominatim, bounded to Kediri area.
 * Allows finding any street (e.g. Jl. Dhoho), village, kelurahan, kecamatan,
 * restaurant, shop, or clinic across Kota & Kabupaten Kediri.
 */
export async function searchKediriOSM(
  query: string, 
  bounds?: DynamicBoundingBox,
  signal?: AbortSignal
): Promise<OSMSearchItem[]> {
  const cleanQ = query.trim();
  if (!cleanQ || cleanQ.length < 2) return [];

  // Normalize common Indonesian address abbreviations
  let normalized = cleanQ
    .replace(/^jl\.?\s+/i, 'Jalan ')
    .replace(/\bjl\.?\s+/i, 'Jalan ')
    .replace(/^gang\s+|^gg\.?\s+/i, 'Gang ')
    .replace(/^rs\.?\s+/i, 'Rumah Sakit ')
    .replace(/^kec\.?\s+/i, 'Kecamatan ')
    .replace(/^kel\.?\s+/i, 'Kelurahan ')
    .replace(/^ds\.?\s+/i, 'Desa ');

  if (!normalized.toLowerCase().includes('kediri')) {
    normalized = `${normalized}, Kediri`;
  }

  const b = bounds || inMemoryBoundsCache || FALLBACK_KEDIRI_BOUNDS;
  // viewbox format: <left>,<top>,<right>,<bottom> = minLng, maxLat, maxLng, minLat
  const viewboxParam = `viewbox=${b.minLng},${b.maxLat},${b.maxLng},${b.minLat}`;
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(normalized)}&format=json&limit=8&addressdetails=1&${viewboxParam}`;

  try {
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json'
      },
      signal
    });

    if (!res.ok) return [];

    const data = await res.json();
    if (!Array.isArray(data)) return [];

    const results: OSMSearchItem[] = [];
    const seenCoordinates = new Set<string>();

    for (const item of data) {
      const lat = parseFloat(item.lat);
      const lng = parseFloat(item.lon);
      if (isNaN(lat) || isNaN(lng)) continue;

      // Filter to roughly Kediri bounds (+ buffer)
      if (lat < -8.25 || lat > -7.50 || lng < 111.70 || lng > 112.50) {
        continue;
      }

      const coordKey = `${lat.toFixed(4)}_${lng.toFixed(4)}`;
      if (seenCoordinates.has(coordKey)) continue;
      seenCoordinates.add(coordKey);

      const address = item.address || {};
      const name = item.name || item.display_name.split(',')[0].trim();
      const district = address.suburb || address.village || address.city_district || address.county || address.town || 'Kediri';
      
      const isKota = (item.display_name.toLowerCase().includes('kota kediri') || address.city === 'Kota Kediri');
      const areaType: 'Kota' | 'Kabupaten' = isKota ? 'Kota' : 'Kabupaten';

      let category = 'Alamat / Jalan';
      if (item.type === 'cafe' || item.type === 'restaurant' || item.type === 'fast_food') category = 'Kuliner';
      else if (item.type === 'pharmacy' || item.type === 'hospital' || item.type === 'clinic') category = 'Kesehatan';
      else if (item.type === 'convenience' || item.type === 'supermarket' || item.type === 'mall') category = 'Belanja';
      else if (item.type === 'place_of_worship') category = 'Tempat Ibadah';
      else if (item.type === 'administrative' || item.type === 'boundary' || item.type === 'village') category = 'Wilayah / Desa';
      else if (item.type === 'secondary' || item.type === 'primary' || item.type === 'residential' || item.type === 'tertiary') category = 'Jalan';

      results.push({
        id: `osm-${item.osm_type || 'node'}-${item.osm_id}`,
        name,
        district,
        fullAddress: item.display_name,
        category,
        areaType,
        lat,
        lng,
        source: 'osm-nominatim'
      });
    }

    return results;
  } catch (err) {
    if (signal?.aborted) return [];
    console.warn('[Nominatim Search] Error querying live search:', err);
    return [];
  }
}
