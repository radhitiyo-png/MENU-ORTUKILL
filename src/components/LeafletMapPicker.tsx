import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import L from 'leaflet';
import { 
  MapPin, 
  Navigation, 
  Compass, 
  CheckCircle2, 
  Store, 
  Search, 
  X, 
  Building2, 
  GraduationCap, 
  Hospital, 
  ShoppingBag, 
  Trees, 
  Crosshair,
  Hotel,
  Utensils,
  Coffee,
  Pill,
  Loader2,
  Route,
  Landmark,
  MapPinned
} from 'lucide-react';
import { STORE_ORIGIN, calculateHaversineDistanceKm, computeTravelDurationMinutes, computeShippingFee } from '../services/deliveryService';
import { KEDIRI_PLACES, searchKediriPlaces, KediriPlace } from '../data/kediriPlaces';
import { fetchKediriDynamicBounds, searchKediriOSM, DynamicBoundingBox, OSMSearchItem } from '../services/nominatimService';
import { fetchKediriPOIs, OverpassPOI } from '../services/overpassService';

interface LeafletMapPickerProps {
  initialLat?: number | null;
  initialLng?: number | null;
  onLocationSelect: (lat: number, lng: number, addressSuggestion?: string) => void;
}

// Pusat Kota Kediri (default awal sebelum Nominatim selesai fetch)
const DEFAULT_KEDIRI = { lat: -7.8234, lng: 112.0123 };

type SearchFilterCategory = 'all' | 'kecamatan' | 'jalan' | 'landmark' | 'belanja' | 'kesehatan' | 'kuliner';

interface UnifiedSearchResult {
  id: string;
  name: string;
  district: string;
  fullAddress: string;
  category: string;
  areaType: 'Kota' | 'Kabupaten';
  lat: number;
  lng: number;
  source: 'database' | 'osm-live' | 'overpass';
}

export const LeafletMapPicker: React.FC<LeafletMapPickerProps> = ({
  initialLat,
  initialLng,
  onLocationSelect
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);

  const [currentLat, setCurrentLat] = useState<number>(initialLat || DEFAULT_KEDIRI.lat);
  const [currentLng, setCurrentLng] = useState<number>(initialLng || DEFAULT_KEDIRI.lng);
  const [isLocating, setIsLocating] = useState<boolean>(false);
  const [locationStatus, setLocationStatus] = useState<string>('Pilih titik kirim di peta Kota & Kab. Kediri');

  // Dynamic Nominatim & Overpass Data (Digunakan untuk Search & Bound dinamis)
  const [dynamicBounds, setDynamicBounds] = useState<DynamicBoundingBox | null>(null);
  const [pois, setPois] = useState<OverpassPOI[]>([]);
  const [isBackgroundIndexing, setIsBackgroundIndexing] = useState<boolean>(true);

  // Search state
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isSearchFocused, setIsSearchFocused] = useState<boolean>(false);
  const [selectedFilter, setSelectedFilter] = useState<SearchFilterCategory>('all');
  const [liveOSMResults, setLiveOSMResults] = useState<OSMSearchItem[]>([]);
  const [isLiveSearching, setIsLiveSearching] = useState<boolean>(false);

  // Debounced search controller
  const searchAbortRef = useRef<AbortController | null>(null);

  // Update position and propagate callback
  const handlePositionChange = useCallback((lat: number, lng: number, label?: string) => {
    setCurrentLat(lat);
    setCurrentLng(lng);
    const roundedLat = lat.toFixed(6);
    const roundedLng = lng.toFixed(6);
    const addr = label || `Area Kediri (${roundedLat}, ${roundedLng})`;
    setLocationStatus(`📍 Terpilih: ${addr}`);
    onLocationSelect(lat, lng, addr);

    if (markerRef.current) {
      markerRef.current.setLatLng([lat, lng]);
    }
  }, [onLocationSelect]);

  // Load Dynamic Nominatim Boundaries & Overpass POIs into memory for complete search coverage
  useEffect(() => {
    let isMounted = true;

    async function initLocationIndex() {
      try {
        setIsBackgroundIndexing(true);
        // Step 1: Geocoding dynamic bounds from Nominatim without hardcoded coordinates
        const bounds = await fetchKediriDynamicBounds();
        if (!isMounted) return;
        setDynamicBounds(bounds);

        // Step 2: Pre-fetch POI catalogue in background for instant search matching
        const loadedPOIs = await fetchKediriPOIs(bounds);
        if (!isMounted) return;
        setPois(loadedPOIs);
      } catch (err) {
        console.warn('Background indexing note:', err);
      } finally {
        if (isMounted) {
          setIsBackgroundIndexing(false);
        }
      }
    }

    initLocationIndex();
    return () => {
      isMounted = false;
    };
  }, []);

  // Debounced Live OSM Nominatim Search for complete streets, villages & places
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q || q.length < 2) {
      setLiveOSMResults([]);
      setIsLiveSearching(false);
      return;
    }

    // Cancel prior request
    if (searchAbortRef.current) {
      searchAbortRef.current.abort();
    }

    const controller = new AbortController();
    searchAbortRef.current = controller;
    setIsLiveSearching(true);

    const timer = setTimeout(async () => {
      try {
        const osmResults = await searchKediriOSM(q, dynamicBounds || undefined, controller.signal);
        if (!controller.signal.aborted) {
          setLiveOSMResults(osmResults);
          setIsLiveSearching(false);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setIsLiveSearching(false);
        }
      }
    }, 350);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [searchQuery, dynamicBounds]);

  // Unified Search Results (Local curated database + POIs + Live OSM Nominatim geocoding)
  const unifiedResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();

    // Default top suggestions when search query is empty
    if (!q) {
      return KEDIRI_PLACES.slice(0, 10).map((place): UnifiedSearchResult => ({
        id: place.id,
        name: place.name,
        district: place.district,
        fullAddress: `${place.name}, Kec. ${place.district} (${place.areaType} Kediri)`,
        category: place.category,
        areaType: place.areaType,
        lat: place.lat,
        lng: place.lng,
        source: 'database'
      }));
    }

    const results: UnifiedSearchResult[] = [];
    const seenCoordinates = new Set<string>();

    // 1. Matches from local curated Kediri database
    const localMatches = searchKediriPlaces(q, 15);
    for (const place of localMatches) {
      const coordKey = `${place.lat.toFixed(3)}_${place.lng.toFixed(3)}`;
      if (!seenCoordinates.has(coordKey)) {
        seenCoordinates.add(coordKey);
        results.push({
          id: place.id,
          name: place.name,
          district: place.district,
          fullAddress: `${place.name}, Kec. ${place.district} (${place.areaType} Kediri)`,
          category: place.category,
          areaType: place.areaType,
          lat: place.lat,
          lng: place.lng,
          source: 'database'
        });
      }
    }

    // 2. Matches from live OpenStreetMap Nominatim search (finds every street, gang, desa, etc.)
    for (const osm of liveOSMResults) {
      const coordKey = `${osm.lat.toFixed(3)}_${osm.lng.toFixed(3)}`;
      if (!seenCoordinates.has(coordKey)) {
        seenCoordinates.add(coordKey);
        results.push({
          id: osm.id,
          name: osm.name,
          district: osm.district,
          fullAddress: osm.fullAddress,
          category: osm.category,
          areaType: osm.areaType,
          lat: osm.lat,
          lng: osm.lng,
          source: 'osm-live'
        });
      }
    }

    // 3. Matches from background Overpass POIs (cafes, restaurants, clinics, minimarkets)
    const overpassMatches = pois
      .filter((p) => p.name.toLowerCase().includes(q) || (p.address && p.address.toLowerCase().includes(q)))
      .slice(0, 10);

    for (const p of overpassMatches) {
      const coordKey = `${p.lat.toFixed(3)}_${p.lng.toFixed(3)}`;
      if (!seenCoordinates.has(coordKey)) {
        seenCoordinates.add(coordKey);
        results.push({
          id: p.id,
          name: p.name,
          district: p.categoryLabel,
          fullAddress: p.address || `${p.name}, Kediri`,
          category: p.categoryLabel,
          areaType: 'Kota',
          lat: p.lat,
          lng: p.lng,
          source: 'overpass'
        });
      }
    }

    // Apply active category filter tab if selected
    if (selectedFilter === 'all') return results.slice(0, 20);

    return results
      .filter((item) => {
        const cat = item.category.toLowerCase();
        if (selectedFilter === 'kecamatan') return cat.includes('kecamatan') || cat.includes('wilayah');
        if (selectedFilter === 'jalan') return cat.includes('jalan') || cat.includes('alamat');
        if (selectedFilter === 'landmark') return cat.includes('landmark') || cat.includes('wisata');
        if (selectedFilter === 'belanja') return cat.includes('mall') || cat.includes('pasar') || cat.includes('belanja') || cat.includes('swalayan');
        if (selectedFilter === 'kesehatan') return cat.includes('rumah sakit') || cat.includes('apotek') || cat.includes('kesehatan') || cat.includes('klinik');
        if (selectedFilter === 'kuliner') return cat.includes('kuliner') || cat.includes('kafe') || cat.includes('restoran') || cat.includes('kopi');
        return true;
      })
      .slice(0, 20);
  }, [searchQuery, liveOSMResults, pois, selectedFilter]);

  // Initialize Pure Clean Map (WITHOUT POI OVERLAYS)
  useEffect(() => {
    if (!mapContainerRef.current) return;
    if (mapInstanceRef.current) return;

    const startLat = initialLat || DEFAULT_KEDIRI.lat;
    const startLng = initialLng || DEFAULT_KEDIRI.lng;

    const initialBounds = L.latLngBounds(L.latLng(-8.20, 111.70), L.latLng(-7.50, 112.45));

    // Pure Raster Map (Super fast & responsive)
    const map = L.map(mapContainerRef.current, {
      center: [startLat, startLng],
      zoom: 13,
      minZoom: 9,
      maxZoom: 18,
      maxBounds: initialBounds,
      maxBoundsViscosity: 0.7,
      attributionControl: false,
      zoomControl: true
    });

    // Pure OSM raster tile
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      subdomains: ['a', 'b', 'c']
    }).addTo(map);

    // Custom Icon Store Base (Ortukill Outlet)
    const storeIcon = L.divIcon({
      className: 'store-custom-marker',
      html: `
        <div style="transform: translate(-50%, -50%); display: flex; flex-direction: column; align-items: center; cursor: pointer;">
          <div style="background: linear-gradient(135deg, #be123c, #4c0519); color: white; width: 34px; height: 34px; border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 10px rgba(0,0,0,0.5); border: 2.5px solid #fde68a; font-size: 16px;">
            🍷
          </div>
          <div style="background: #1e1b4b; color: #fde68a; font-size: 9px; font-weight: 800; padding: 1px 6px; border-radius: 6px; margin-top: 2px; border: 1px solid #d97706; white-space: nowrap; box-shadow: 0 2px 4px rgba(0,0,0,0.3);">
            BASE TOKO
          </div>
        </div>
      `,
      iconSize: [36, 48],
      iconAnchor: [18, 24]
    });

    const storeMarker = L.marker([STORE_ORIGIN.lat, STORE_ORIGIN.lng], {
      icon: storeIcon,
      interactive: true
    }).addTo(map);

    storeMarker.bindPopup(`
      <div style="font-family: sans-serif; font-size: 12px; color: #0f172a; padding: 2px;">
        <strong style="color: #be123c;">🍷 Ortukill Kediri (Base Outlet)</strong><br/>
        <span style="font-size: 11px; color: #64748b;">7°48'33.3"S 112°01'20.0"E</span><br/>
        <span style="font-size: 11px; font-weight: bold; color: #059669;">✨ Radius Bebas Ongkir: ≤ ${STORE_ORIGIN.freeShippingRadiusKm} km</span>
      </div>
    `);

    // Lingkaran radius gratis ongkir (10 KM)
    L.circle([STORE_ORIGIN.lat, STORE_ORIGIN.lng], {
      radius: STORE_ORIGIN.freeShippingRadiusKm * 1000,
      color: '#10b981',
      fillColor: '#10b981',
      fillOpacity: 0.09,
      weight: 1.5,
      dashArray: '5, 5'
    }).addTo(map);

    // Custom Icon Customer Delivery Location (Draggable)
    const customerIcon = L.divIcon({
      className: 'customer-custom-marker',
      html: `
        <div style="transform: translate(-50%, -50%); display: flex; flex-direction: column; align-items: center; cursor: grab;">
          <div style="background: linear-gradient(135deg, #e11d48, #9f1239); color: white; width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 12px rgba(225,29,72,0.6); border: 2.5px solid #ffffff; font-size: 18px;">
            📍
          </div>
          <div style="background: #e11d48; color: white; font-size: 9px; font-weight: 800; padding: 1px 6px; border-radius: 6px; margin-top: 2px; border: 1px solid white; white-space: nowrap; box-shadow: 0 2px 4px rgba(0,0,0,0.3);">
            LOKASI ANDA
          </div>
        </div>
      `,
      iconSize: [40, 52],
      iconAnchor: [20, 26]
    });

    const customerMarker = L.marker([startLat, startLng], {
      icon: customerIcon,
      draggable: true
    }).addTo(map);

    customerMarker.on('dragend', () => {
      const position = customerMarker.getLatLng();
      handlePositionChange(position.lat, position.lng);
    });

    // Ketuk langsung pada peta untuk memindahkan pin pengiriman
    map.on('click', (e: L.LeafletMouseEvent) => {
      customerMarker.setLatLng(e.latlng);
      handlePositionChange(e.latlng.lat, e.latlng.lng);
    });

    mapInstanceRef.current = map;
    markerRef.current = customerMarker;

    const timer = setTimeout(() => {
      map.invalidateSize();
    }, 200);

    return () => {
      clearTimeout(timer);
      map.remove();
      mapInstanceRef.current = null;
      markerRef.current = null;
    };
  }, [handlePositionChange, initialLat, initialLng]);

  // Update map boundary constraint dynamically when Nominatim bounds are resolved
  useEffect(() => {
    if (!mapInstanceRef.current || !dynamicBounds) return;
    const dynamicLeafletBounds = L.latLngBounds(
      L.latLng(dynamicBounds.minLat, dynamicBounds.minLng),
      L.latLng(dynamicBounds.maxLat, dynamicBounds.maxLng)
    );
    mapInstanceRef.current.setMaxBounds(dynamicLeafletBounds);
  }, [dynamicBounds]);

  // Select place from search results
  const handleSelectPlace = (place: UnifiedSearchResult) => {
    handlePositionChange(place.lat, place.lng, place.fullAddress);

    if (mapInstanceRef.current) {
      mapInstanceRef.current.flyTo([place.lat, place.lng], 15, { duration: 1 });
    }

    setSearchQuery(place.name);
    setIsSearchFocused(false);
  };

  // Jump to Base Toko Ortukill
  const handleJumpToOutlet = () => {
    handlePositionChange(STORE_ORIGIN.lat, STORE_ORIGIN.lng, 'Outlet Ortukill Kediri (Base Toko)');
    if (mapInstanceRef.current) {
      mapInstanceRef.current.flyTo([STORE_ORIGIN.lat, STORE_ORIGIN.lng], 15, { duration: 0.8 });
    }
    setSearchQuery('Outlet Ortukill Kediri');
    setIsSearchFocused(false);
  };

  // Deteksi GPS HP/Browser
  const handleGPSDetect = () => {
    if (!navigator.geolocation) {
      setLocationStatus('⚠️ Browser Anda tidak mendukung GPS.');
      return;
    }

    setIsLocating(true);
    setLocationStatus('🔍 Mengambil titik GPS Anda...');

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        setIsLocating(false);
        setLocationStatus(`✅ GPS Akurat (${latitude.toFixed(5)}, ${longitude.toFixed(5)})`);

        if (mapInstanceRef.current && markerRef.current) {
          mapInstanceRef.current.flyTo([latitude, longitude], 15, { duration: 0.8 });
          markerRef.current.setLatLng([latitude, longitude]);
        }
        handlePositionChange(latitude, longitude, 'Lokasi GPS Akurat Anda');
      },
      (error) => {
        setIsLocating(false);
        let msg = 'Gagal mengambil GPS.';
        if (error.code === error.PERMISSION_DENIED) {
          msg = 'Izin lokasi tidak diberikan. Silakan ketik nama tempat di pencarian atau geser pin di peta.';
        }
        setLocationStatus(`⚠️ ${msg}`);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  };

  // Category Icon Resolver
  const getCategoryIcon = (cat: string) => {
    const lower = cat.toLowerCase();
    if (lower.includes('hotel') || lower.includes('penginapan')) return <Hotel className="w-3.5 h-3.5 text-purple-400 shrink-0" />;
    if (lower.includes('restoran') || lower.includes('kuliner')) return <Utensils className="w-3.5 h-3.5 text-orange-400 shrink-0" />;
    if (lower.includes('kafe') || lower.includes('kopi')) return <Coffee className="w-3.5 h-3.5 text-amber-400 shrink-0" />;
    if (lower.includes('apotek') || lower.includes('kesehatan') || lower.includes('klinik')) return <Pill className="w-3.5 h-3.5 text-emerald-400 shrink-0" />;
    if (lower.includes('rumah sakit')) return <Hospital className="w-3.5 h-3.5 text-emerald-400 shrink-0" />;
    if (lower.includes('kampus') || lower.includes('sekolah')) return <GraduationCap className="w-3.5 h-3.5 text-blue-400 shrink-0" />;
    if (lower.includes('pasar') || lower.includes('swalayan') || lower.includes('belanja') || lower.includes('mall')) return <ShoppingBag className="w-3.5 h-3.5 text-amber-400 shrink-0" />;
    if (lower.includes('wisata') || lower.includes('taman')) return <Trees className="w-3.5 h-3.5 text-teal-400 shrink-0" />;
    if (lower.includes('jalan') || lower.includes('alamat')) return <Route className="w-3.5 h-3.5 text-sky-400 shrink-0" />;
    if (lower.includes('kecamatan') || lower.includes('wilayah') || lower.includes('desa')) return <Landmark className="w-3.5 h-3.5 text-amber-300 shrink-0" />;
    return <Building2 className="w-3.5 h-3.5 text-rose-400 shrink-0" />;
  };

  return (
    <div className="space-y-2.5">
      {/* 1. Quick Search Box Se-Kota & Kabupaten Kediri */}
      <div className="relative">
        <div className="relative flex items-center">
          <Search className="absolute left-3.5 w-4 h-4 text-amber-400/90 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setIsSearchFocused(true);
            }}
            onFocus={() => setIsSearchFocused(true)}
            placeholder="🔎 Ketik jalan, desa, kecamatan, patokan, toko, cafe di Kediri..."
            className="w-full pl-10 pr-16 py-2.5 bg-[#180408] border border-rose-700/70 focus:border-amber-400 rounded-xl text-xs sm:text-sm text-white placeholder-rose-400/50 shadow-inner focus:outline-none transition-all"
          />

          <div className="absolute right-2.5 flex items-center gap-1">
            {isLiveSearching && (
              <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin" />
            )}
            {searchQuery && (
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('');
                  setLiveOSMResults([]);
                  setIsSearchFocused(false);
                }}
                className="p-1 rounded-full text-rose-400 hover:text-white hover:bg-rose-900/50 transition-colors cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Quick Category Filter Chips under Search Input */}
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pt-1.5 pb-0.5">
          {[
            { id: 'all' as const, label: 'Semua Titik' },
            { id: 'kecamatan' as const, label: '🏛️ Kecamatan' },
            { id: 'jalan' as const, label: '🛣️ Jalan & Alamat' },
            { id: 'landmark' as const, label: '🗼 Landmark' },
            { id: 'belanja' as const, label: '🛍️ Mall & Pasar' },
            { id: 'kesehatan' as const, label: '🏥 Rumah Sakit' },
            { id: 'kuliner' as const, label: '☕ Kuliner & Kafe' }
          ].map((chip) => {
            const isSelected = selectedFilter === chip.id;
            return (
              <button
                key={chip.id}
                type="button"
                onClick={() => {
                  setSelectedFilter(chip.id);
                  setIsSearchFocused(true);
                }}
                className={`px-2.5 py-1 rounded-lg text-[10.5px] font-semibold whitespace-nowrap transition-all cursor-pointer ${
                  isSelected
                    ? 'bg-amber-400 text-slate-950 font-bold shadow-sm'
                    : 'bg-[#22070c] text-rose-200/90 hover:text-white border border-rose-900/60 hover:bg-rose-900/40'
                }`}
              >
                {chip.label}
              </button>
            );
          })}
        </div>

        {/* Dropdown Hasil Pencarian Komprehensif */}
        {isSearchFocused && unifiedResults.length > 0 && (
          <div className="absolute left-0 right-0 top-full mt-1.5 z-40 bg-[#160307] border-2 border-rose-700/80 rounded-2xl shadow-2xl overflow-hidden max-h-72 overflow-y-auto divide-y divide-rose-950/60 backdrop-blur-xl">
            <div className="p-2 bg-rose-950/90 text-[10.5px] font-bold text-amber-300 flex items-center justify-between border-b border-rose-900/40">
              <span className="flex items-center gap-1.5">
                <MapPinned className="w-3.5 h-3.5 text-amber-400" />
                {searchQuery ? `Hasil Pencarian Lengkap (${unifiedResults.length} Lokasi)` : 'Rekomendasi Titik Antar Se-Kediri:'}
              </span>
              <button
                type="button"
                onClick={() => setIsSearchFocused(false)}
                className="text-rose-300 hover:text-white cursor-pointer"
              >
                Tutup ✕
              </button>
            </div>

            {unifiedResults.map((place) => {
              const distKm = calculateHaversineDistanceKm(STORE_ORIGIN.lat, STORE_ORIGIN.lng, place.lat, place.lng);
              const estMinutes = computeTravelDurationMinutes(distKm);
              const { fee, isFree } = computeShippingFee(distKm, estMinutes);

              return (
                <button
                  key={place.id}
                  type="button"
                  onClick={() => handleSelectPlace(place)}
                  className="w-full p-2.5 px-3 text-left hover:bg-rose-900/50 transition-colors flex items-center justify-between gap-2.5 text-xs group cursor-pointer"
                >
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    <div className="p-1.5 rounded-lg bg-rose-950/80 border border-rose-800/60 group-hover:border-amber-400/60 transition-colors">
                      {getCategoryIcon(place.category)}
                    </div>
                    <div className="truncate flex-1">
                      <div className="flex items-center gap-1.5 truncate">
                        <span className="font-bold text-white block truncate group-hover:text-amber-200 text-xs">
                          {place.name}
                        </span>
                        <span className={`text-[9px] font-bold px-1.5 py-0.2 rounded border shrink-0 ${
                          place.areaType === 'Kota'
                            ? 'bg-rose-950/90 text-rose-300 border-rose-800'
                            : 'bg-emerald-950/90 text-emerald-300 border-emerald-800'
                        }`}>
                          {place.areaType}
                        </span>
                      </div>
                      <span className="text-[10px] text-slate-300 block truncate mt-0.5">
                        {place.fullAddress}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-col items-end shrink-0 gap-0.5">
                    <div className="flex items-center gap-1 text-[10px]">
                      <span className="text-slate-300 font-mono">~{distKm.toFixed(1)} km</span>
                      <span className="text-slate-500">•</span>
                      <span className="text-amber-300 font-mono">~{estMinutes} mnt</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className={`text-[9.5px] font-bold px-1.5 py-0.2 rounded-md ${
                        isFree 
                          ? 'bg-emerald-950/90 text-emerald-300 border border-emerald-800' 
                          : 'bg-rose-950/90 text-rose-300 border border-rose-800'
                      }`}>
                        {isFree ? '✨ Gratis Ongkir' : `Rp ${fee.toLocaleString('id-ID')}`}
                      </span>
                      <Crosshair className="w-3.5 h-3.5 text-amber-400 opacity-60 group-hover:opacity-100 group-hover:scale-110 transition-all ml-1" />
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* 2. Action Bar: GPS & Base Outlet */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleGPSDetect}
            disabled={isLocating}
            className="flex-1 sm:flex-initial flex items-center justify-center gap-1.5 px-3 py-1.5 bg-rose-950/90 hover:bg-rose-900 border border-rose-700/60 text-rose-200 rounded-xl font-bold text-xs transition-all shadow-md active:scale-95 disabled:opacity-50 cursor-pointer"
          >
            <Navigation className={`w-3.5 h-3.5 text-rose-400 ${isLocating ? 'animate-spin' : ''}`} />
            <span>{isLocating ? 'Mencari GPS...' : '📍 Gunakan GPS Saya'}</span>
          </button>

          <button
            type="button"
            onClick={handleJumpToOutlet}
            className="flex items-center justify-center gap-1 px-3 py-1.5 bg-amber-950/60 hover:bg-amber-900/60 border border-amber-600/50 text-amber-200 rounded-xl font-bold text-xs transition-all shadow-md active:scale-95 cursor-pointer"
          >
            <Store className="w-3.5 h-3.5 text-amber-400" />
            <span>Outlet Kediri</span>
          </button>
        </div>

        <div className="flex items-center gap-1.5 text-[10.5px] text-emerald-300 bg-black/60 px-2.5 py-1.5 rounded-xl border border-emerald-900/60">
          <span className="w-2 h-2 rounded-full bg-emerald-400 inline-block animate-pulse"></span>
          <span>Radius ≤ 10 km Bebas Ongkir (Lingkaran Hijau)</span>
        </div>
      </div>

      {/* 3. Pure Leaflet Map Canvas (NO CLUTTERED POI OVERLAYS) */}
      <div className="relative rounded-2xl overflow-hidden border border-rose-800/60 shadow-lg group">
        <div ref={mapContainerRef} className="w-full h-64 sm:h-72 z-10" />

        {/* Legend Overlay */}
        <div className="absolute top-2 right-2 z-20 bg-black/85 backdrop-blur-md px-2.5 py-1 rounded-lg border border-slate-800 text-[10px] text-slate-300 flex items-center gap-2 shadow">
          <span className="flex items-center gap-1"><span className="text-xs">🍷</span> Outlet Base</span>
          <span className="text-slate-600">|</span>
          <span className="flex items-center gap-1"><span className="text-xs">📍</span> Lokasi Kirim Anda</span>
        </div>

        {/* Status Bar */}
        <div className="absolute bottom-2 left-2 right-2 z-20 bg-black/90 backdrop-blur-md px-3 py-1.5 rounded-xl border border-rose-900/60 text-[11px] text-rose-200 flex items-center justify-between shadow-md">
          <span className="truncate">{locationStatus}</span>
          <span className="font-mono text-emerald-400 shrink-0 flex items-center gap-1 font-semibold ml-2 text-[10.5px]">
            <CheckCircle2 className="w-3.5 h-3.5" /> Titik Aktif
          </span>
        </div>
      </div>

      {/* 4. Coordinate & Instruction Bar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 bg-rose-950/30 border border-rose-900/30 rounded-xl p-2.5">
        <div className="flex items-start gap-2 text-xs text-slate-300">
          <MapPin className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
          <div>
            <span className="font-bold text-white block text-[11px]">Koordinat Pengiriman untuk Kurir:</span>
            <a
              href={`https://www.google.com/maps?q=${currentLat},${currentLng}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-rose-400 underline font-mono text-[10.5px] break-all hover:text-rose-300"
            >
              https://www.google.com/maps?q={currentLat.toFixed(6)},{currentLng.toFixed(6)}
            </a>
          </div>
        </div>

        <div className="text-[11px] text-slate-400 flex items-center gap-1 self-end sm:self-auto">
          <Compass className="w-3.5 h-3.5 text-rose-400" />
          <span>Geser pin 📍 atau cari nama tempat di atas</span>
        </div>
      </div>
    </div>
  );
};
