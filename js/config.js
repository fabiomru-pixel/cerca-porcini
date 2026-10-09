// Regole di base (dalle slide) e parametri predefiniti.
// Tutto ciò che è "regolabile" finisce nelle impostazioni utente (db 'settings').

export const APP_VERSION = '1.12.0';

export const DEFAULT_SETTINGS = {
  gradient: 0.6,          // °C ogni 100 m (regolabile 0,6–0,7)
  windowDays: 7,          // giorni per la media di massime/minime (1–20)
  rainWindowDays: 20,     // finestra per la pioggia cumulata
  rainMinMm: 30,          // pioggia minima nei 20 giorni precedenti
  rainEventMm: 10,       // un giorno con almeno questi mm avvia/riavvia il timer
  radiusKm: 50,           // 5–200 km (barra)
  species: 'auto',        // auto | aestivalis | aereus | edulis | pinophilus
  aspectPref: 'auto',     // auto | N | NE | E | SE | S | SO | O | NO
  southOffsetM: 175,      // versante Sud percepito 150–200 m più in basso
  maxSpots: 25,
  maxWalkMin: 40,         // oltre questi minuti a piedi dalla strada lo spot non conta
  theme: 'auto',          // auto | light | dark
  // Client ID OAuth pubblico (progetto Google Cloud "cerca-porcini"): non è un segreto
  driveClientId: '516872585382-51m78latk5r073hl7dftqs6ggj44sstu.apps.googleusercontent.com',
  driveFolderId: '',
  lastSync: null,
};

// Finestre termiche (slide "Fase 2")
export const SPECIES = {
  // months = stagione possibile, peak = mesi di punta (peso pieno); fuori punta peso 0,7
  aestivalis: { label: 'Boletus aestivalis', common: 'Porcino estivo', group: 'caldo', months: [5, 6, 7, 8, 9], peak: [6, 7, 8] },
  aereus:     { label: 'Boletus aereus',     common: 'Porcino nero',   group: 'caldo', months: [6, 7, 8, 9, 10], peak: [7, 8, 9] },
  edulis:     { label: 'Boletus edulis',     common: 'Porcino autunnale', group: 'fresco', months: [8, 9, 10, 11], peak: [9, 10] },
  pinophilus: { label: 'Boletus pinophilus', common: 'Porcino rosso',  group: 'fresco', months: [5, 6, 9, 10, 11], peak: [9, 10] },
};

// Gruppi: finestra termica + tipo di bosco + timer dopo la pioggia
// timer: start = primi funghi possibili, optStart–optEnd = finestra migliore, end = fine finestra
export const GROUPS = {
  caldo: {
    label: 'Estivo (aestivalis / aereus)',
    tMin: 18, tMax: 24,
    forest: 'quercia',
    color: '#e07b22',
  },
  fresco: {
    label: 'Autunnale (edulis / pinophilus)',
    tMin: 12, tMax: 18,
    forest: 'faggio',
    color: '#2e8b57',
  },
};

// Slide 10 / 17-19: "lepri" e "diesel"
export const FORESTS = {
  quercia: {
    label: 'Querce & Castagni',
    altMin: 200, altMax: 900,
    tempOffsetC: +0.5,               // terreno più caldo, luminoso
    timer: { start: 7, optStart: 8, optEnd: 12, end: 16 },
  },
  faggio: {
    label: 'Faggi & Abeti',
    altMin: 1000, altMax: 1600,
    tempOffsetC: -1.0,               // ombra profonda: circa -1 °C al suolo
    timer: { start: 9, optStart: 15, optEnd: 21, end: 24 },
  },
};

// "Killer" del bosco
export const KILLERS = {
  frostC: 0,           // notti a zero gradi
  heatC: 30,           // caldo estremo
  tramontanaKmh: 30,   // vento forte da N/NE
  tramontanaDirs: [315, 60], // settore da NO a ENE
};


export const TILE_LAYERS = {
  topo: {
    name: 'Topografica',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    opts: { crossOrigin: true, maxZoom: 17, subdomains: 'abc', attribution: '© OpenStreetMap, SRTM | © OpenTopoMap (CC-BY-SA)' },
  },
  osm: {
    name: 'Stradale',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    opts: { crossOrigin: true, maxZoom: 19, attribution: '© OpenStreetMap contributors' },
  },
  sat: {
    name: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    opts: { crossOrigin: true, maxZoom: 18, attribution: 'Tiles © Esri' },
  },
};

export const DEM_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

// Copernicus High Resolution Layer "Forest Type 2018" (10 m): 0 = non bosco, latifoglie, conifere
export const FOREST_TYPE_URL =
  'https://image.discomap.eea.europa.eu/arcgis/rest/services/GioLandPublic/HRL_ForestType_2018/ImageServer/exportImage';

export const EEA_PROTECTED_URL =
  'https://bio.discomap.eea.europa.eu/arcgis/rest/services/ProtectedSites/CDDA_Dyna_WM/MapServer/3/query';

// Servizio Cloudflare che legge i pluviometri SIR per l'app (codice in cloudflare/sir-worker.js).
// Vuoto = si usa solo data/pluviometri.json
export const SIR_PROXY_URL = '';
