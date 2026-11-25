import { DynamicBoundingBox, fetchKediriDynamicBounds } from './nominatimService';
import { KEDIRI_PLACES } from '../data/kediriPlaces';

export type POICategory = 'restoran' | 'kafe' | 'apotek' | 'masjid' | 'minimarket' | 'hotel';

export interface OverpassPOI {
  id: string;
  name: string;
  lat: number;
  lng: number;
  category: POICategory;
  categoryLabel: string;
  iconEmoji: string;
  address?: string;
  source: 'overpass-live' | 'nominatim-poi' | 'cached' | 'fallback';
}

const POI_CACHE_KEY = 'kediri_overpass_pois_v1';
let inMemoryPOICache: OverpassPOI[] | null = null;

export const POI_CATEGORIES: Array<{
  id: POICategory | 'all';
  label: string;
  emoji: string;
  color: string;
}> = [
  { id: 'all', label: 'Semua POI', emoji: '📍', color: '#be123c' },
  { id: 'hotel', label: 'Hotel & Penginapan', emoji: '🏨', color: '#8b5cf6' },
  { id: 'restoran', label: 'Restoran', emoji: '🍽️', color: '#ea580c' },
  { id: 'kafe', label: 'Kafe & Kopi', emoji: '☕', color: '#b45309' },
  { id: 'apotek', label: 'Apotek', emoji: '💊', color: '#059669' },
  { id: 'masjid', label: 'Masjid', emoji: '🕌', color: '#0d9488' },
  { id: 'minimarket', label: 'Minimarket & Swalayan', emoji: '🏪', color: '#2563eb' }
];

export function getPOICategoryInfo(category: POICategory) {
  switch (category) {
    case 'hotel':
      return { label: 'Hotel & Penginapan', emoji: '🏨', color: '#8b5cf6', badgeBg: 'bg-purple-950/80 text-purple-300 border-purple-800' };
    case 'restoran':
      return { label: 'Restoran', emoji: '🍽️', color: '#ea580c', badgeBg: 'bg-amber-950/80 text-orange-300 border-orange-800' };
    case 'kafe':
      return { label: 'Kafe & Kopi', emoji: '☕', color: '#b45309', badgeBg: 'bg-amber-950/80 text-amber-300 border-amber-800' };
    case 'apotek':
      return { label: 'Apotek & Farma', emoji: '💊', color: '#059669', badgeBg: 'bg-emerald-950/80 text-emerald-300 border-emerald-800' };
    case 'masjid':
      return { label: 'Masjid', emoji: '🕌', color: '#0d9488', badgeBg: 'bg-teal-950/80 text-teal-300 border-teal-800' };
    case 'minimarket':
      return { label: 'Minimarket', emoji: '🏪', color: '#2563eb', badgeBg: 'bg-blue-950/80 text-blue-300 border-blue-800' };
    default:
      return { label: 'Tempat POI', emoji: '📍', color: '#e11d48', badgeBg: 'bg-rose-950/80 text-rose-300 border-rose-800' };
  }
}

/**
 * Build Overpass QL query string for requested bounding box
 */
function buildOverpassQL(bounds: DynamicBoundingBox): string {
  // Bounding box in Overpass QL: (south, west, north, east)
  const bbox = `${bounds.minLat},${bounds.minLng},${bounds.maxLat},${bounds.maxLng}`;

  return `[out:json][timeout:25];
(
  nw["amenity"~"restaurant|cafe|fast_food|pharmacy|hospital|clinic|place_of_worship|school|bank"](${bbox});
  nw["shop"~"convenience|supermarket|mall|bakery|department_store"](${bbox});
  nw["tourism"~"hotel|guest_house|hostel|attraction"](${bbox});
);
out center 1500;`;
}

/**
 * Fetch POIs from Overpass API using dynamically geocoded Kediri bounding box
 */
export async function fetchKediriPOIs(customBounds?: DynamicBoundingBox): Promise<OverpassPOI[]> {
  // 1. Return in-memory cache if available
  if (inMemoryPOICache && inMemoryPOICache.length > 0) {
    return inMemoryPOICache;
  }

  // 2. Return sessionStorage cache if available
  try {
    const cached = sessionStorage.getItem(POI_CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached) as OverpassPOI[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        inMemoryPOICache = parsed;
        return parsed;
      }
    }
  } catch {
    // Ignore cache retrieval errors
  }

  // 3. Obtain dynamic bounds from Nominatim (No hardcoded values)
  const bounds = customBounds || (await fetchKediriDynamicBounds());

  // Overpass mirror endpoints to try
  const overpassEndpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
  ];

  const query = buildOverpassQL(bounds);

  for (const endpoint of overpassEndpoints) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 7000);

      const params = new URLSearchParams();
      params.append('data', query);

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        },
        body: params,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const json = await response.json();
        if (json && Array.isArray(json.elements) && json.elements.length > 0) {
          const pois: OverpassPOI[] = [];
          const seenNames = new Set<string>();

          for (const el of json.elements) {
            const lat = el.lat ?? el.center?.lat;
            const lng = el.lon ?? el.center?.lon;
            const tags = el.tags || {};
            const name = tags.name || tags['brand'] || tags['operator'];

            if (!lat || !lng || !name) continue;

            // Avoid near duplicates
            const normalized = `${name.toLowerCase()}_${lat.toFixed(3)}_${lng.toFixed(3)}`;
            if (seenNames.has(normalized)) continue;
            seenNames.add(normalized);

            // Determine POI category
            let category: POICategory = 'restoran';
            if (tags.tourism === 'hotel' || tags.tourism === 'guest_house' || tags.tourism === 'hostel') {
              category = 'hotel';
            } else if (tags.amenity === 'cafe') {
              category = 'kafe';
            } else if (tags.amenity === 'pharmacy') {
              category = 'apotek';
            } else if (tags.amenity === 'place_of_worship' || name.toLowerCase().includes('masjid')) {
              category = 'masjid';
            } else if (tags.shop === 'convenience' || tags.shop === 'supermarket') {
              category = 'minimarket';
            } else if (tags.amenity === 'restaurant') {
              category = 'restoran';
            }

            const info = getPOICategoryInfo(category);
            const address = [tags['addr:street'], tags['addr:district'], tags['addr:city']]
              .filter(Boolean)
              .join(', ');

            pois.push({
              id: `osm-${el.type}-${el.id}`,
              name,
              lat,
              lng,
              category,
              categoryLabel: info.label,
              iconEmoji: info.emoji,
              address: address || undefined,
              source: 'overpass-live'
            });
          }

          if (pois.length > 0) {
            saveToCache(pois);
            return pois;
          }
        }
      }
    } catch (err) {
      console.warn(`[Overpass] Endpoint ${endpoint} failed or timed out:`, err);
    }
  }

  // 4. Fallback: Query Nominatim Search API dynamically within the dynamic bbox
  const fallbackPOIs = await fetchNominatimPOIFallback(bounds);
  if (fallbackPOIs.length > 0) {
    saveToCache(fallbackPOIs);
    return fallbackPOIs;
  }

  // 5. Ultimate safety net: derive POIs from Kediri places dataset
  const localFallback = derivePOIsFromKediriPlaces();
  saveToCache(localFallback);
  return localFallback;
}

function saveToCache(pois: OverpassPOI[]) {
  inMemoryPOICache = pois;
  try {
    sessionStorage.setItem(POI_CACHE_KEY, JSON.stringify(pois));
  } catch {
    // Ignore cache quota errors
  }
}

/**
 * Fallback to Nominatim search for Kediri POIs if Overpass API public nodes are congested
 */
async function fetchNominatimPOIFallback(bounds: DynamicBoundingBox): Promise<OverpassPOI[]> {
  const categoriesToSearch: Array<{ q: string; cat: POICategory }> = [
    { q: 'hotel di Kediri', cat: 'hotel' },
    { q: 'restoran di Kediri', cat: 'restoran' },
    { q: 'kafe di Kediri', cat: 'kafe' },
    { q: 'apotek di Kediri', cat: 'apotek' },
    { q: 'masjid di Kediri', cat: 'masjid' },
    { q: 'minimarket di Kediri', cat: 'minimarket' }
  ];

  const pois: OverpassPOI[] = [];
  const viewbox = `${bounds.minLng},${bounds.maxLat},${bounds.maxLng},${bounds.minLat}`;

  for (const item of categoriesToSearch) {
    try {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(item.q)}&format=json&limit=10&viewbox=${viewbox}&bounded=1`;
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json' }
      });
      if (res.ok) {
        const list = await res.json();
        if (Array.isArray(list)) {
          for (const p of list) {
            const lat = parseFloat(p.lat);
            const lng = parseFloat(p.lon);
            if (!isNaN(lat) && !isNaN(lng)) {
              const info = getPOICategoryInfo(item.cat);
              pois.push({
                id: `nom-${p.place_id}`,
                name: p.name || p.display_name?.split(',')[0] || 'Tempat di Kediri',
                lat,
                lng,
                category: item.cat,
                categoryLabel: info.label,
                iconEmoji: info.emoji,
                address: p.display_name,
                source: 'nominatim-poi'
              });
            }
          }
        }
      }
    } catch {
      // Continue to next category
    }
  }

  return pois;
}

/**
 * Generate fallback POIs from rich Kediri Places catalogue
 */
function derivePOIsFromKediriPlaces(): OverpassPOI[] {
  const list: OverpassPOI[] = [];

  for (const place of KEDIRI_PLACES) {
    let category: POICategory | null = null;
    if (place.category === 'Hotel & Penginapan') {
      category = 'hotel';
    } else if (place.name.toLowerCase().includes('masjid')) {
      category = 'masjid';
    } else if (place.name.toLowerCase().includes('apotek') || place.name.toLowerCase().includes('farma')) {
      category = 'apotek';
    } else if (place.name.toLowerCase().includes('kopi') || place.name.toLowerCase().includes('cafe') || place.name.toLowerCase().includes('kafe')) {
      category = 'kafe';
    } else if (place.category === 'Mall & Pasar' || place.name.toLowerCase().includes('mart') || place.name.toLowerCase().includes('indomaret') || place.name.toLowerCase().includes('alfamart')) {
      category = 'minimarket';
    } else if (place.category === 'Wisata & Taman' || place.category === 'Landmark') {
      category = 'restoran';
    }

    if (category) {
      const info = getPOICategoryInfo(category);
      list.push({
        id: `local-${place.id}`,
        name: place.name,
        lat: place.lat,
        lng: place.lng,
        category,
        categoryLabel: info.label,
        iconEmoji: info.emoji,
        address: `Kec. ${place.district}, ${place.areaType} Kediri`,
        source: 'fallback'
      });
    }
  }

  return list;
}
