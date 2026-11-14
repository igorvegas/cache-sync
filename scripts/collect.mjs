import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import {
  SCHEMA_VERSION, comparable, failureStatus, okStatus,
  parseRepairsHtml, sameFailure, validateOutages,
} from './lib/outages.mjs';

const SOURCE_URL = (process.env.SOURCE_URL || '').trim();
if (!/^https?:\/\//i.test(SOURCE_URL)) {
  console.error('::error::Не задан секрет SOURCE_URL');
  process.exit(1);
}
const MAX_RETRY = Number(process.env.MAX_RETRY || 4);
const OUT = process.env.OUT_FILE || path.join('data', 'state.json');
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOST = new URL(SOURCE_URL).host;
const redact = (v) => String(v).split(SOURCE_URL).join('***').split(HOST).join('***');
const log = (...a) => console.log('[collect]', ...a.map(redact));

async function fetchOnce(context) {
  const page = await context.newPage();
  try {
    await page.goto(SOURCE_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    // список рисуется JS-ом (скриптом страницы); пустой список тоже валиден
    await page.waitForSelector('ul.shutdown-crush-list', { state: 'attached', timeout: 20_000 }).catch(() => {});
    // небольшая пауза, чтобы строки успели отрисоваться после появления <ul>
    await page.waitForSelector('li.shutdown-crush-item', { timeout: 4_000 }).catch(() => {});
    return parseRepairsHtml(await page.content());
  } finally {
    await page.close();
  }
}

async function readExisting() {
  try { return JSON.parse(await fs.readFile(OUT, 'utf8')); } catch { return null; }
}
async function writeOut(obj) {
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  const tmp = `${OUT}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n');
  await fs.rename(tmp, OUT);
}

let browser = null, context = null, result = null, lastReason = 'нет данных';
try {
  browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
  context = await browser.newContext({
    userAgent: USER_AGENT, locale: 'uk-UA', timezoneId: 'Europe/Kyiv', viewport: { width: 1366, height: 900 },
  });
} catch (e) {
  lastReason = `браузер не запущен: ${e.message.split('\n')[0]}`;
}

for (let attempt = 1; context && attempt <= MAX_RETRY && !result; attempt++) {
  try {
    log(`попытка ${attempt}/${MAX_RETRY}`);
    const res = await fetchOnce(context);
    const v = validateOutages(res);
    if (v.ok) result = res;
    else lastReason = v.reason;
  } catch (e) {
    lastReason = e.message.split('\n')[0];
  }
  if (!result) {
    log(`неудача: ${lastReason}`);
    if (attempt < MAX_RETRY) await sleep(2000 * attempt + Math.random() * 500);
  }
}
await browser?.close();

const existing = await readExisting();

if (!result) {
  const message = redact(lastReason);
  console.warn(`::warning::Не удалось получить список после ${MAX_RETRY} попыток: ${message}`);
  if (existing) {
    const status = failureStatus(message);
    if (!sameFailure(existing.lastUpdateStatus, status)) {
      await writeOut({ ...existing, lastUpdateStatus: status });
      log('записан статус ошибки');
    }
  }
  process.exit(0);
}

const now = new Date().toISOString();
const recovered = existing?.lastUpdateStatus?.ok === false;
const hasMeta = existing?.meta?.schemaVersion === SCHEMA_VERSION;
const changed = !existing || comparable(existing.outages) !== comparable(result.outages);

if (!changed && !recovered && hasMeta) {
  log(`без изменений (записей: ${result.outages.length})`);
  process.exit(0);
}

await writeOut({
  lastUpdated: changed ? now : existing.lastUpdated,
  outages: changed ? result.outages : existing.outages,
  lastUpdateStatus: okStatus(now),
  meta: { schemaVersion: SCHEMA_VERSION },
});
log(changed ? `записано: ${result.outages.length} отключ.` : 'статус восстановлен');
