// IPA Servicios — backend
//
// Fuentes:
//   - Machu Picchu: tuboleto.cultura.pe (oficial). Se accede via Playwright
//     conectado a Browserless.io para usar IPs rotativas residenciales que
//     no estén bloqueadas por el WAF del Mincu.
//   - Vuelos: SerpAPI Google Flights.

require('dotenv').config();
const express = require('express');
const path = require('path');
const { chromium } = require('playwright-core');

const PORT = process.env.PORT || 3000;
const SERPAPI_KEY = process.env.SERPAPI_KEY;
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;
const CACHE_TTL_MS = 5 * 60 * 1000;

const SITE_URL = 'https://tuboleto.cultura.pe/llaqta_machupicchu';
const API_URL = 'https://api-tuboleto.cultura.pe';
const APIWAIT_FECHAS = '/visita/consulta-fechas-disponibles';
const APIWAIT_HORARIOS = '/visita/consulta-horarios';

const SEL = {
  matSelect: 'mat-select',
  matOption: 'mat-option',
  calendar: 'mat-calendar',
  calendarHeader: '.mat-calendar-period-button',
  calendarCell: '.mat-calendar-body-cell',
  calendarNext: '.mat-calendar-next-button',
  calendarPrev: '.mat-calendar-previous-button',
  openCalendar: 'button[aria-label="Open calendar"]',
};

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// --- Caché y single-flight ----------------------------------------------
const cache = new Map();
function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expires < Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}
function cacheSet(key, data) {
  cache.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
}

const inFlight = new Map();
function singleFlight(key, fn) {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const p = (async () => {
    try { return await fn(); }
    finally { inFlight.delete(key); }
  })();
  inFlight.set(key, p);
  return p;
}

// --- Conexión a Browserless ---------------------------------------------
// URL para Playwright nativo (no CDP). Endpoint v2 con región SFO.
// Cada llamada abre una conexión nueva → IP rotativa por consulta.
const BROWSERLESS_REGION = process.env.BROWSERLESS_REGION || 'production-sfo';
async function connectBrowser() {
  if (!BROWSERLESS_TOKEN) {
    throw new Error(
      'Falta configurar BROWSERLESS_TOKEN en archivo .env. Registrate en https://www.browserless.io',
    );
  }
  const url = `wss://${BROWSERLESS_REGION}.browserless.io/chromium/playwright?token=${BROWSERLESS_TOKEN}`;
  return chromium.connect(url);
}

// --- Sesiones reutilizables de browser por (circuito, ruta) -------------
// Cuando termina una consulta, dejamos el browser vivo 45s para que la
// siguiente consulta de la misma ruta (típicamente click en un día) reuse
// el setup en lugar de rehacer todo.
const SESSION_TTL_MS = 45_000;
const sessions = new Map(); // key: "mp:circuito:ruta" → { browser, context, page, timer, busy }

function sessionKey(idCircuito, idRuta) {
  return `mp:${idCircuito}:${idRuta}`;
}

async function cerrarSesion(key) {
  const s = sessions.get(key);
  if (!s) return;
  sessions.delete(key);
  clearTimeout(s.timer);
  await s.context.close().catch(() => {});
  await s.browser.close().catch(() => {});
}

function programarCierre(key) {
  const s = sessions.get(key);
  if (!s) return;
  clearTimeout(s.timer);
  s.timer = setTimeout(() => cerrarSesion(key), SESSION_TTL_MS);
}

// Devuelve una sesión lista para usar (browser + page con circuito y ruta
// seleccionados, calendario abierto). Reusa si ya hay una activa para la
// misma key, sino crea una nueva.
async function obtenerSesion(idCircuitoQ, idRutaQ) {
  const key = sessionKey(idCircuitoQ, idRutaQ);
  const existing = sessions.get(key);
  if (existing && !existing.busy) {
    clearTimeout(existing.timer);
    existing.busy = true;
    existing.reused = true;
    return existing;
  }
  // Si la sesión está ocupada por otra consulta paralela, abrimos una nueva
  // efímera (no la guardamos en el Map para no romper la sesión activa).
  if (existing && existing.busy) {
    const { circuito, ruta, idxCircuito, idxRuta } = await resolverIndices(idCircuitoQ, idRutaQ);
    const browser = await connectBrowser();
    const { page, context } = await abrirFormularioConCalendario(browser, idxCircuito, idxRuta);
    return { browser, context, page, circuito, ruta, idCircuitoQ, idRutaQ, busy: true, reused: false, efimera: true };
  }
  const { circuito, ruta, idxCircuito, idxRuta } = await resolverIndices(idCircuitoQ, idRutaQ);
  const browser = await connectBrowser();
  const { page, context } = await abrirFormularioConCalendario(browser, idxCircuito, idxRuta);
  const session = {
    browser, context, page,
    circuito, ruta,
    idCircuitoQ, idRutaQ,
    timer: null, busy: true, reused: false, efimera: false,
  };
  sessions.set(key, session);
  return session;
}

// Marca la sesión libre y programa su cierre. Si la sesión es efímera
// (otra estaba corriendo en paralelo), la cerramos directo.
async function liberarSesion(session) {
  if (session.efimera) {
    await session.context.close().catch(() => {});
    await session.browser.close().catch(() => {});
    return;
  }
  session.busy = false;
  programarCierre(sessionKey(session.idCircuitoQ, session.idRutaQ));
}

// --- Llamada directa a /visita/lugar-info (intenta sin browser primero) -
async function fetchLugarInfo() {
  const cached = cacheGet('lugar-info');
  if (cached) return cached;

  // Intento 1: fetch directo (algunas IPs sí pasan)
  let lastErr;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(`${API_URL}/visita/lugar-info?idLugar=llaqta_machupicchu`, {
        headers: {
          accept: 'application/json, text/plain, */*',
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          referer: 'https://tuboleto.cultura.pe/',
          origin: 'https://tuboleto.cultura.pe',
        },
      });
      if (r.status === 403) {
        lastErr = new Error('lugar-info HTTP 403');
        break; // 403 no se resuelve con retry, salimos al fallback
      }
      if (!r.ok) throw new Error('lugar-info HTTP ' + r.status);
      const data = await r.json();
      const out = {
        ...data,
        circuitos: JSON.parse(data.circuitos || '[]'),
        procedencias: JSON.parse(data.procedencias || '[]'),
      };
      cacheSet('lugar-info', out);
      return out;
    } catch (e) {
      lastErr = e;
    }
  }

  // Intento 2: usar el browser de Browserless (IP rotativa)
  if (!BROWSERLESS_TOKEN) throw lastErr;
  const browser = await connectBrowser();
  const context = await browser.newContext({ locale: 'es-PE' });
  try {
    const page = await context.newPage();
    await page.goto(SITE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.locator('mat-select').first().waitFor({ timeout: 60000 });
    const data = await page.evaluate(async (url) => {
      const r = await fetch(url, { headers: { accept: 'application/json, text/plain, */*' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }, `${API_URL}/visita/lugar-info?idLugar=llaqta_machupicchu`);
    const out = {
      ...data,
      circuitos: JSON.parse(data.circuitos || '[]'),
      procedencias: JSON.parse(data.procedencias || '[]'),
    };
    cacheSet('lugar-info', out);
    return out;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

app.get('/api/lugar-info', async (req, res) => {
  try {
    res.json(await fetchLugarInfo());
  } catch (e) {
    const msg = e.message;
    const esBloqueo = /403|tuboleto|forbbiden|forbidden/i.test(msg);
    res.status(esBloqueo ? 503 : 500).json({
      error: esBloqueo
        ? 'La API de tuboleto.cultura.pe está bloqueando la conexión (403). Intentá de nuevo en unos minutos.'
        : msg,
    });
  }
});

async function resolverIndices(idCircuitoQ, idRutaQ) {
  const info = await fetchLugarInfo();
  const idxCircuito = info.circuitos.findIndex((c) => c.nidcircuito === idCircuitoQ);
  if (idxCircuito < 0) throw new Error('Circuito no encontrado');
  const circuito = info.circuitos[idxCircuito];
  const idxRuta = circuito.rutas.findIndex((r) => r.nidruta === idRutaQ);
  if (idxRuta < 0) throw new Error('Ruta no encontrada');
  return { circuito, ruta: circuito.rutas[idxRuta], idxCircuito, idxRuta };
}

function waitApi(page, pattern, ms = 8000) {
  return page
    .waitForResponse((r) => r.url().includes(pattern), { timeout: ms })
    .catch(() => null);
}

function leerHeaderCalendario(page) {
  return page.evaluate((s) => document.querySelector(s)?.innerText.trim() || '', SEL.calendarHeader);
}

async function abrirFormularioConCalendario(browser, idxCircuito, idxRuta) {
  const context = await browser.newContext({
    locale: 'es-PE',
    viewport: { width: 1366, height: 1100 },
  });
  try {
    const page = await context.newPage();
    await page.goto(SITE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    await page.locator(SEL.matSelect).first().waitFor({ timeout: 60000 });
    await page.waitForFunction(
      () => {
        const sels = document.querySelectorAll('mat-select');
        return sels.length >= 2 && !sels[0].classList.contains('mat-mdc-select-disabled');
      },
      { timeout: 20000 },
    );
    await page.waitForTimeout(1200);

    await page.locator(SEL.matSelect).nth(0).click({ force: true });
    await page.locator(SEL.matOption).first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(200);
    await page.locator(SEL.matOption).nth(idxCircuito).click({ force: true });

    await page.waitForFunction(
      () => {
        const sels = document.querySelectorAll('mat-select');
        return sels[1] && !sels[1].classList.contains('mat-mdc-select-disabled');
      },
      { timeout: 10000 },
    );
    await page.waitForTimeout(300);

    await page.locator(SEL.matSelect).nth(1).click({ force: true });
    await page.locator(SEL.matOption).first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(200);
    const respRuta = waitApi(page, APIWAIT_FECHAS, 15000);
    await page.locator(SEL.matOption).nth(idxRuta).click({ force: true });
    await respRuta;
    await page.waitForTimeout(500);

    await page.keyboard.press('Escape').catch(() => {});
    await asegurarCalendarioAbierto(page);

    return { page, context };
  } catch (e) {
    await context.close().catch(() => {});
    throw e;
  }
}

async function asegurarCalendarioAbierto(page) {
  const open = await page.locator(SEL.calendar).count();
  if (open === 0) {
    await page.evaluate(() => {
      document.querySelectorAll('.cdk-overlay-backdrop').forEach((b) => b.remove());
    });
    await page.evaluate((s) => document.querySelector(s)?.click(), SEL.openCalendar);
    await page.locator(SEL.calendarCell).first().waitFor({ timeout: 8000 });
  }
}

const MESES_ABREV = [
  ['ene'], ['feb'], ['mar'], ['abr'], ['may'], ['jun'],
  ['jul'], ['ago'], ['set', 'sep'], ['oct'], ['nov'], ['dic'],
];

function parseHeaderCalendario(header) {
  const m = header.match(/([A-ZÁ-Úa-zá-ú.]+)\s+(\d{4})/);
  if (!m) return null;
  const abrev = m[1].toLowerCase().replace('.', '').slice(0, 3);
  const idx = MESES_ABREV.findIndex((arr) => arr.includes(abrev));
  if (idx < 0) return null;
  return { mes: idx, anio: parseInt(m[2], 10) };
}

async function navegarA(page, targetMes, targetAnio) {
  for (let i = 0; i < 24; i++) {
    await asegurarCalendarioAbierto(page);
    const header = await leerHeaderCalendario(page);
    const parsed = parseHeaderCalendario(header);
    if (!parsed) return false;
    if (parsed.mes === targetMes && parsed.anio === targetAnio) return true;
    const adelante = parsed.anio * 12 + parsed.mes < targetAnio * 12 + targetMes;
    const ok = await cambiarMes(page, adelante);
    if (!ok) return false;
  }
  return false;
}

// El click sobre el botón de cambio suele cerrar el panel del calendario en
// esta SPA; navegarA reabre con asegurarCalendarioAbierto y reintenta.
async function cambiarMes(page, adelante = true) {
  const respPromise = waitApi(page, APIWAIT_FECHAS, 10000);
  const clickResult = await page.evaluate(
    ({ next, prev, adv }) => {
      const btn = document.querySelector(adv ? next : prev);
      if (!btn || btn.hasAttribute('disabled')) return false;
      btn.click();
      return true;
    },
    { next: SEL.calendarNext, prev: SEL.calendarPrev, adv: adelante },
  );
  if (!clickResult) return false;
  await respPromise;
  await page.waitForTimeout(1200);
  return true;
}

app.get('/api/disponibilidad', async (req, res) => {
  const idCircuitoQ = parseInt(req.query.circuito, 10);
  const idRutaQ = parseInt(req.query.ruta, 10);
  const meses = Math.min(parseInt(req.query.meses, 10) || 3, 12);
  const noCache = req.query.nocache === '1';
  if (!idCircuitoQ || !idRutaQ) return res.status(400).json({ error: 'Faltan params: circuito, ruta' });

  const cacheKey = `disp:${idCircuitoQ}:${idRutaQ}:${meses}`;
  if (!noCache) {
    const cached = cacheGet(cacheKey);
    if (cached) {
      res.set('X-Cache', 'HIT');
      return res.json(cached);
    }
  }

  try {
    const out = await singleFlight(cacheKey, async () => {
      const t0 = Date.now();
      const session = await obtenerSesion(idCircuitoQ, idRutaQ);
      try {
        const { page, circuito, ruta } = session;
        const headerInicial = await leerHeaderCalendario(page);
        const inicial = parseHeaderCalendario(headerInicial);
        if (!inicial) throw new Error(`No se pudo parsear el header inicial: "${headerInicial}"`);

        const mesesData = [];
        for (let i = 0; i < meses; i++) {
          const targetMes = (inicial.mes + i) % 12;
          const targetAnio = inicial.anio + Math.floor((inicial.mes + i) / 12);
          const ok = await navegarA(page, targetMes, targetAnio);
          if (!ok) break;
          const mesData = await page.evaluate(
            ({ headerSel, cellSel }) => {
              const headerLabel = document.querySelector(headerSel)?.innerText.trim() || '';
              const celdas = [...document.querySelectorAll(cellSel)].map((c) => ({
                dia: c.innerText.trim(),
                ariaLabel: c.getAttribute('aria-label'),
                disabled: c.classList.contains('mat-calendar-body-disabled'),
              }));
              return { mes: headerLabel, celdas };
            },
            { headerSel: SEL.calendarHeader, cellSel: SEL.calendarCell },
          );
          mesesData.push(mesData);
        }
        const result = {
          circuito,
          ruta,
          meses: mesesData,
          generadoEn: new Date().toISOString(),
          tomoMs: Date.now() - t0,
          reused: session.reused,
        };
        cacheSet(cacheKey, result);
        return result;
      } finally {
        await liberarSesion(session);
      }
    });
    res.set('X-Cache', 'MISS');
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/horarios', async (req, res) => {
  const idCircuitoQ = parseInt(req.query.circuito, 10);
  const idRutaQ = parseInt(req.query.ruta, 10);
  const fecha = req.query.fecha;
  const noCache = req.query.nocache === '1';
  if (!idCircuitoQ || !idRutaQ || !fecha) {
    return res.status(400).json({ error: 'Faltan params: circuito, ruta, fecha (YYYY-MM-DD)' });
  }
  const m = fecha.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return res.status(400).json({ error: 'fecha debe ser YYYY-MM-DD' });
  const targetYear = parseInt(m[1], 10);
  const targetMonth = parseInt(m[2], 10) - 1;
  const targetDay = parseInt(m[3], 10);

  const cacheKey = `hor:${idCircuitoQ}:${idRutaQ}:${fecha}`;
  if (!noCache) {
    const cached = cacheGet(cacheKey);
    if (cached) {
      res.set('X-Cache', 'HIT');
      return res.json(cached);
    }
  }

  try {
    const out = await singleFlight(cacheKey, async () => {
      const t0 = Date.now();
      const session = await obtenerSesion(idCircuitoQ, idRutaQ);
      try {
        const { page, circuito, ruta } = session;
        // Cerrar el dropdown de horarios si quedó abierto de una consulta anterior
        await page.keyboard.press('Escape').catch(() => {});

        const llegoAlMes = await navegarA(page, targetMonth, targetYear);
        if (!llegoAlMes) throw new Error('No se pudo navegar al mes solicitado');
        await asegurarCalendarioAbierto(page);

        const celdaInfo = await page.evaluate(
          ({ dia, cellSel }) => {
            const celdas = [...document.querySelectorAll(cellSel)];
            const idx = celdas.findIndex((c) => c.innerText.trim() === String(dia));
            if (idx < 0) return { found: false };
            const c = celdas[idx];
            return {
              found: true,
              idx,
              disabled: c.classList.contains('mat-calendar-body-disabled'),
              ariaLabel: c.getAttribute('aria-label'),
            };
          },
          { dia: targetDay, cellSel: SEL.calendarCell },
        );
        if (!celdaInfo.found) throw new Error('Día no encontrado en el calendario');
        if (celdaInfo.disabled) {
          const result = {
            circuito,
            ruta,
            fecha,
            disponible: false,
            horarios: [],
            mensaje: 'Día agotado o no permitido',
            tomoMs: Date.now() - t0,
            reused: session.reused,
          };
          cacheSet(cacheKey, result);
          return result;
        }

        const respHorarios = waitApi(page, APIWAIT_HORARIOS, 10000);
        await page.evaluate(
          ({ idx, cellSel }) => {
            const cell = document.querySelectorAll(cellSel)[idx];
            cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            cell.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          },
          { idx: celdaInfo.idx, cellSel: SEL.calendarCell },
        );
        await respHorarios;
        // Mini buffer para que Angular populate el dropdown de horarios
        await page.waitForTimeout(400);

        await page.locator(SEL.matSelect).nth(2).click({ force: true });
        await page.locator(SEL.matOption).first().waitFor({ timeout: 6000 });

        const horarios = await page.evaluate(() => {
          return [...document.querySelectorAll('mat-option')].map((o) => {
            const text = o.innerText.trim().replace(/\s+/g, ' ');
            const horaMatch = text.match(/(\d{2}:\d{2})/);
            const cuposMatch = text.match(/(\d+)\s*boleto/i);
            return {
              texto: text,
              hora: horaMatch ? horaMatch[1] : null,
              cupos: cuposMatch ? parseInt(cuposMatch[1], 10) : null,
              disabled:
                o.classList.contains('mat-mdc-option-disabled') ||
                o.getAttribute('aria-disabled') === 'true',
            };
          });
        });

        const result = {
          circuito,
          ruta,
          fecha,
          disponible: horarios.length > 0,
          horarios,
          generadoEn: new Date().toISOString(),
          tomoMs: Date.now() - t0,
          reused: session.reused,
        };
        cacheSet(cacheKey, result);
        return result;
      } finally {
        await liberarSesion(session);
      }
    });
    res.set('X-Cache', 'MISS');
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/cache', (req, res) => {
  const entries = [...cache.entries()].map(([k, v]) => ({
    key: k,
    expira: new Date(v.expires).toISOString(),
    expiraEn: Math.max(0, Math.round((v.expires - Date.now()) / 1000)) + 's',
  }));
  res.json({ ttlSegundos: CACHE_TTL_MS / 1000, total: entries.length, entries });
});
app.delete('/api/cache', (req, res) => {
  const n = cache.size;
  cache.clear();
  res.json({ borrados: n });
});

// --- Vuelos (SerpAPI Google Flights) -------------------------------------

function horaToMin(hhmm) {
  const m = (hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function minToFmt(min) {
  if (typeof min !== 'number' || isNaN(min)) return '';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return [h ? `${h}h` : '', m ? `${m}m` : ''].filter(Boolean).join(' ') || '0m';
}

function parsearTarjetaSerpapi(card) {
  const segs = card.flights || [];
  const first = segs[0] || {};
  const last = segs[segs.length - 1] || {};
  const salida = first.departure_airport?.time || '';
  const llegada = last.arrival_airport?.time || '';
  return {
    aerolinea: first.airline || '',
    aerolineaLogo: first.airline_logo || card.airline_logo || '',
    numeroVuelo: first.flight_number || '',
    origen: first.departure_airport?.id || '',
    origenNombre: first.departure_airport?.name || '',
    destino: last.arrival_airport?.id || '',
    destinoNombre: last.arrival_airport?.name || '',
    salidaIso: salida,
    llegadaIso: llegada,
    salidaHora: (salida.split(' ')[1] || '').slice(0, 5),
    llegadaHora: (llegada.split(' ')[1] || '').slice(0, 5),
    fechaSalida: salida.split(' ')[0] || '',
    fechaLlegada: llegada.split(' ')[0] || '',
    duracion: minToFmt(card.total_duration),
    escalas: Math.max(0, segs.length - 1),
    precio: card.price,
    segmentos: segs.map((s) => ({
      aerolinea: s.airline,
      numero: s.flight_number,
      origen: s.departure_airport?.id,
      destino: s.arrival_airport?.id,
      salida: s.departure_airport?.time,
      llegada: s.arrival_airport?.time,
      duracion: minToFmt(s.duration),
    })),
  };
}

async function buscarTramoSerpapi({ origen, destino, fecha, adultos, ninos, bebes, moneda, aerolinea }) {
  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'google_flights');
  url.searchParams.set('departure_id', origen);
  url.searchParams.set('arrival_id', destino);
  url.searchParams.set('outbound_date', fecha);
  url.searchParams.set('type', '2');
  url.searchParams.set('currency', moneda);
  url.searchParams.set('hl', 'es');
  url.searchParams.set('gl', 'pe');
  url.searchParams.set('adults', String(adultos));
  if (ninos > 0) url.searchParams.set('children', String(ninos));
  if (bebes > 0) url.searchParams.set('infants_in_lap', String(bebes));
  if (aerolinea) url.searchParams.set('include_airlines', aerolinea);
  url.searchParams.set('api_key', SERPAPI_KEY);

  let lastErr;
  for (let intento = 0; intento < 3; intento++) {
    if (intento > 0) await new Promise((r) => setTimeout(r, 2000 * intento));

    const r = await fetch(url);
    const data = await r.json().catch(() => null);

    if (data?.error) {
      const msg = String(data.error);
      if (/hasn't returned any results|no results|couldn't find/i.test(msg)) return [];
      if (/internal serpapi error|temporarily unavailable|try again/i.test(msg)) {
        lastErr = new Error('SerpAPI temporalmente caído. Reintentá en 30s.');
        continue;
      }
      throw new Error(msg);
    }
    if (!r.ok) {
      lastErr = new Error(`SerpAPI HTTP ${r.status}`);
      if (r.status >= 500) continue;
      throw lastErr;
    }
    const cartas = [...(data.best_flights || []), ...(data.other_flights || [])];
    return cartas.map(parsearTarjetaSerpapi);
  }
  throw lastErr;
}

const COSTO_MALETA = {
  USD: 40,
  PEN: 150,
  EUR: 35,
  COP: 175000,
  MXN: 700,
};

app.get('/api/vuelos', async (req, res) => {
  try {
    const origen = (req.query.origen || '').toUpperCase().trim();
    const destino = (req.query.destino || '').toUpperCase().trim();
    const fechaIda = req.query.fecha;
    const fechaVuelta = req.query.fechaVuelta || null;
    const horaMaxLlegadaIda = req.query.horaMax || null;
    const horaMinSalidaVuelta = req.query.horaMinVuelta || null;
    const adultos = parseInt(req.query.adultos, 10) || 1;
    const ninos = Math.max(0, parseInt(req.query.ninos, 10) || 0);
    const bebes = Math.max(0, parseInt(req.query.bebes, 10) || 0);
    const maletas = Math.max(0, Math.min(2, parseInt(req.query.maletas, 10) || 0));
    const aerolinea = (req.query.aerolinea || '').toUpperCase().trim() || null;
    const moneda = (req.query.moneda || 'USD').toUpperCase();

    if (!SERPAPI_KEY) {
      return res.status(500).json({ error: 'Falta configurar SERPAPI_KEY en archivo .env' });
    }
    if (!origen || !destino || !fechaIda) {
      return res.status(400).json({ error: 'Faltan parámetros: origen, destino, fecha' });
    }
    if (!/^[A-Z]{3}$/.test(origen) || !/^[A-Z]{3}$/.test(destino)) {
      return res.status(400).json({ error: 'origen y destino deben ser códigos IATA (LIM, CUZ, etc.)' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaIda)) {
      return res.status(400).json({ error: 'fecha debe ser YYYY-MM-DD' });
    }
    if (fechaVuelta && !/^\d{4}-\d{2}-\d{2}$/.test(fechaVuelta)) {
      return res.status(400).json({ error: 'fechaVuelta debe ser YYYY-MM-DD' });
    }
    if (adultos + ninos > 9) {
      return res.status(400).json({ error: 'Máximo 9 pasajeros con asiento (adultos + niños)' });
    }
    if (aerolinea && !/^[A-Z0-9]{2,3}$/.test(aerolinea)) {
      return res.status(400).json({ error: 'aerolinea debe ser código IATA de 2-3 caracteres' });
    }

    const cacheKey = `vue:${origen}:${destino}:${fechaIda}:${fechaVuelta || ''}:${horaMaxLlegadaIda || ''}:${horaMinSalidaVuelta || ''}:${adultos}:${ninos}:${bebes}:${maletas}:${aerolinea || ''}:${moneda}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      res.set('X-Cache', 'HIT');
      return res.json(cached);
    }

    const opcionesSerpapi = { adultos, ninos, bebes, moneda, aerolinea };
    let idas = await buscarTramoSerpapi({ origen, destino, fecha: fechaIda, ...opcionesSerpapi });
    if (horaMaxLlegadaIda) {
      const limite = horaToMin(horaMaxLlegadaIda);
      if (limite != null) idas = idas.filter((v) => horaToMin(v.llegadaHora) <= limite);
    }
    idas.sort((a, b) => a.precio - b.precio);

    let resultado;
    if (fechaVuelta) {
      let vueltas = await buscarTramoSerpapi({
        origen: destino,
        destino: origen,
        fecha: fechaVuelta,
        ...opcionesSerpapi,
      });
      if (horaMinSalidaVuelta) {
        const limite = horaToMin(horaMinSalidaVuelta);
        if (limite != null) vueltas = vueltas.filter((v) => horaToMin(v.salidaHora) >= limite);
      }
      vueltas.sort((a, b) => a.precio - b.precio);
      const combos = [];
      for (const ida of idas.slice(0, 10)) {
        for (const vuelta of vueltas.slice(0, 10)) {
          combos.push({ ida, vuelta, precioTotal: (ida.precio || 0) + (vuelta.precio || 0) });
        }
      }
      combos.sort((a, b) => a.precioTotal - b.precioTotal);
      resultado = {
        tipo: 'ida-vuelta',
        opciones: combos.slice(0, 5),
        totalIdas: idas.length,
        totalVueltas: vueltas.length,
      };
    } else {
      resultado = {
        tipo: 'solo-ida',
        opciones: idas.slice(0, 5).map((ida) => ({ ida, precioTotal: ida.precio })),
        totalIdas: idas.length,
      };
    }

    if (maletas > 0) {
      const costoUnitario = COSTO_MALETA[moneda] ?? COSTO_MALETA.USD;
      const paxConAsiento = adultos + ninos;
      const costoMaletasTotal = costoUnitario * maletas * paxConAsiento;
      resultado.opciones = resultado.opciones.map((o) => ({
        ...o,
        precioVuelo: o.precioTotal,
        costoMaletas: costoMaletasTotal,
        precioTotal: o.precioTotal + costoMaletasTotal,
      }));
      resultado.opciones.sort((a, b) => a.precioTotal - b.precioTotal);
    }

    const out = {
      params: {
        origen, destino, fechaIda, fechaVuelta,
        horaMaxLlegadaIda, horaMinSalidaVuelta,
        adultos, ninos, bebes, maletas,
        aerolinea, moneda,
      },
      ...resultado,
      generadoEn: new Date().toISOString(),
    };
    cacheSet(cacheKey, out);
    res.set('X-Cache', 'MISS');
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n  Servidor escuchando en http://localhost:${PORT}\n`);
  if (!BROWSERLESS_TOKEN) console.log('  ⚠️  BROWSERLESS_TOKEN no configurado — Machu Picchu no va a funcionar');
  if (!SERPAPI_KEY) console.log('  ⚠️  SERPAPI_KEY no configurado — Vuelos no va a funcionar');
});
