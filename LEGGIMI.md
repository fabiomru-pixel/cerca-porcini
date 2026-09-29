# Cerca Porcini

Web app installabile (PWA): una sola app che funziona su PC Windows (Chrome/Edge) e su Android (Chrome).

## Cosa fa
- **Analisi**: parte dalla tua posizione (valle di riferimento) e legge il meteo con Open-Meteo. Calcola la media di massime e minime degli ultimi N giorni (1–20, impostabile) e la pioggia dei 20 giorni precedenti (soglia 30 mm). Poi individua l'ultimo episodio di pioggia utile, che avvia il timer.
- **Quota target**: (T valle − T target) / gradiente × 100 + quota di partenza. Il gradiente è regolabile tra 0,6 e 0,7. Le finestre termiche sono 18–24 °C per aestivalis/aereus e 12–18 °C per edulis/pinophilus. La specie è proposta in base alla stagione.
- **Correttivi**: il versante Sud vale come 150–200 m più in basso. Col caldo l'app preferisce Nord/Nord-Est, col fresco Sud/Sud-Est. Il bosco sposta la temperatura al suolo: faggio −1 °C, querce e castagni +0,5 °C. Pianori e falsopiani sono premiati, i pendii ripidi penalizzati. I margini e le radure ricevono un piccolo bonus.
- **Timer del micelio**: querce e castagni ("lepri") 7–16 gg, con finestra migliore 8–12. Faggi e abeti ("diesel") 9–24 gg, con finestra migliore 15–21. Il timer si ferma con tramontana forte, notti a 0 °C o massime sopra 30 °C.
- **Bosco reale**: carta Copernicus HRL Forest Type (10 m). Gli spot fuori dal bosco vengono scartati.
- **Aree protette**: elenco ufficiale EUAP (dati EEA), disegnate in mappa e segnalate su ogni spot.
- **GPX per Mapy.com**: contiene gli spot consigliati, le fungaie salvate e le curve di livello della fascia di quota vicino agli spot.
- **Fungaie**: salvano posizione GPS, data/ora, temperatura, specie, quantità, bosco, note e foto. Offline si salva tutto subito; quota, esposizione e temperatura vengono completate quando torna la rete.
- **Affinamento**: ogni fungaia sposta un po' la finestra termica e il timer verso quello che funziona nelle tue zone. Le regole di base valgono come 4 ritrovamenti, così i primi dati non stravolgono il calcolo.
- **Offline**: l'app, l'ultima analisi e le fungaie restano disponibili. "Salva offline" scarica le mappe attorno agli spot.
- **Google Drive**: sincronizza fungaie e foto nella cartella "Cerca Porcini".

## Pubblicazione gratuita su GitHub Pages
1. Crea un account su github.com (se non lo hai).
2. Crea un repository privato o pubblico chiamato `cerca-porcini`. Per GitHub Pages gratuito il repository deve essere pubblico. Nel codice non ci sono dati personali: fungaie e foto restano sul telefono e sul tuo Drive.
3. Carica il contenuto di questa cartella (tranne `LEGGIMI.md`, se preferisci).
4. Vai in **Settings → Pages → Branch: main / root → Save**.
5. Dopo 1–2 minuti l'app è su `https://TUONOME.github.io/cerca-porcini/`.

## Installazione
- **Android**: apri l'indirizzo in Chrome → menu ⋮ → **Installa app**.
- **PC**: apri l'indirizzo in Chrome o Edge → icona "Installa" nella barra degli indirizzi.

## Google Drive (una volta sola)
1. Vai su https://console.cloud.google.com/ e crea un progetto.
2. Abilita **Google Drive API**.
3. Nella **Schermata consenso OAuth** scegli il tipo Esterno e aggiungi la tua Gmail agli utenti di test.
4. In **Credenziali → ID client OAuth → Applicazione web** inserisci come origine autorizzata `https://TUONOME.github.io`.
5. Incolla l'ID client nell'app, in **Opzioni → Google Drive**, poi premi **Sincronizza**.

## Fonti dati (gratuite)
Open-Meteo (meteo), AWS Terrain Tiles (altimetria), Copernicus HRL Forest Type 2018 (boschi), EEA NatDA/EUAP (aree protette), OpenTopoMap / OpenStreetMap / Esri (mappe).
