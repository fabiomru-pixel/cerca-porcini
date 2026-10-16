// Web o app Android (Capacitor): stesse funzioni, strumenti diversi.
// Nell'app i plugin nativi danno GPS anche a schermo spento, voce e vibrazione; nel browser si usano le API web.
const C = window.Capacitor;
export const NATIVE = !!(C && typeof C.isNativePlatform === 'function' && C.isNativePlatform());
export const plugin = (name) => (NATIVE ? C.Plugins?.[name] : null);

// I dati aggiornati (pluviometri) stanno sul sito: l'app li prende da lì
export const SITE = 'https://fabiomru-pixel.github.io/cerca-porcini/';
export const dataUrl = (p) => (NATIVE ? SITE + p : p);

// ---- voce
export async function speak(text) {
  try {
    const tts = plugin('TextToSpeech');
    if (tts) { await tts.speak({ text, lang: 'it-IT', rate: 1.0, category: 'playback' }); return; }
    if ('speechSynthesis' in window) {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'it-IT';
      speechSynthesis.speak(u);
    }
  } catch (e) { console.warn('voce', e); }
}

// ---- vibrazione (ms, oppure sequenza [vibra, pausa, vibra…])
export async function vibrate(pattern) {
  try {
    const h = plugin('Haptics');
    const seq = Array.isArray(pattern) ? pattern : [pattern];
    if (h) {
      for (let i = 0; i < seq.length; i++) {
        if (i % 2 === 0) await h.vibrate({ duration: seq[i] });
        else await new Promise((r) => setTimeout(r, seq[i]));
      }
      return;
    }
    navigator.vibrate?.(pattern);
  } catch (e) { console.warn('vibrazione', e); }
}

// ---- posizione continua: nell'app anche a schermo spento (servizio in primo piano con notifica fissa)
// cb({ lat, lon, acc, heading, speed, time }) · restituisce una funzione per fermare
export async function watchPosition(cb, onError) {
  const bg = plugin('BackgroundGeolocation');
  if (bg) {
    const id = await bg.addWatcher({
      backgroundTitle: 'Cerca Porcini',
      backgroundMessage: 'Navigazione a piedi attiva',
      requestPermissions: true,
      stale: false,
      distanceFilter: 3,
    }, (loc, err) => {
      if (err) { onError?.(err.code === 'NOT_AUTHORIZED' ? 'Permesso di posizione negato: attivalo nelle impostazioni dell\'app' : err.message); return; }
      if (loc) cb({ lat: loc.latitude, lon: loc.longitude, acc: loc.accuracy, heading: loc.bearing ?? null, speed: loc.speed ?? null, time: loc.time || Date.now() });
    });
    return () => bg.removeWatcher({ id });
  }
  // browser: funziona solo a schermo acceso, quindi tengo lo schermo sveglio
  let lock = null;
  try { lock = await navigator.wakeLock?.request('screen'); } catch { lock = null; }
  const relock = async () => { if (document.visibilityState === 'visible' && lock?.released) { try { lock = await navigator.wakeLock.request('screen'); } catch { /* niente */ } } };
  document.addEventListener('visibilitychange', relock);
  const wid = navigator.geolocation.watchPosition(
    (p) => cb({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, heading: p.coords.heading, speed: p.coords.speed, time: p.timestamp }),
    (e) => onError?.(e.code === 1 ? 'Permesso di posizione negato' : 'Posizione non disponibile'),
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
  );
  return () => { navigator.geolocation.clearWatch(wid); document.removeEventListener('visibilitychange', relock); lock?.release?.(); };
}
