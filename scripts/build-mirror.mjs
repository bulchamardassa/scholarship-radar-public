import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const sourceOrigin = process.env.SOURCE_ORIGIN || "https://scholarship-radar.scholarship-radar-worker.workers.dev";
const targetOrigin = process.env.TARGET_ORIGIN || "https://bulchamardassa.github.io";
const basePath = (process.env.BASE_PATH || "/scholarship-radar-public").replace(/\/$/, "");
const outputRoot = join(process.cwd(), process.env.OUTPUT_DIR || ".site");
const excludedPrefixes = ["/account", "/admin", "/api", "/submit"];
const sourceAliases = new Set([sourceOrigin, "http://localhost:4321"]);
const routeQueue = [];
const routeKeys = new Set();
const assetQueue = [];
const assetKeys = new Set();
const fetchedAssets = new Set();

function excluded(pathname) {
  return excludedPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function routeKey(url) {
  const page = url.searchParams.get("page");
  return page && /^\d+$/.test(page) ? `${url.pathname}?page=${page}` : url.pathname;
}

function outputPath(url) {
  const page = url.searchParams.get("page");
  const pathname = url.pathname.replace(/^\/+|\/+$/g, "");
  if (page && /^\d+$/.test(page)) return join(outputRoot, pathname, "page", page, "index.html");
  if (!pathname) return join(outputRoot, "index.html");
  if (pathname.endsWith(".xml") || pathname.endsWith(".txt") || pathname.includes(".")) {
    return join(outputRoot, pathname);
  }
  return join(outputRoot, pathname, "index.html");
}

function publicPath(url) {
  const page = url.searchParams.get("page");
  const pathname = url.pathname === "/" ? "/" : `${url.pathname.replace(/\/$/, "")}/`;
  if (page && /^\d+$/.test(page)) return `${basePath}${pathname}page/${page}/`;
  return `${basePath}${pathname}`;
}

function enqueueRoute(value, current = new URL(sourceOrigin)) {
  let url;
  try {
    url = new URL(value, current);
  } catch {
    return;
  }
  if (![sourceOrigin, ...sourceAliases].some((origin) => url.origin === origin)) return;
  if (excluded(url.pathname)) return;
  if ([...url.searchParams.keys()].some((key) => key !== "page")) return;
  url = new URL(`${sourceOrigin}${url.pathname}${url.search}`);
  const key = routeKey(url);
  if (routeKeys.has(key)) return;
  routeKeys.add(key);
  routeQueue.push(url);
}

function enqueueAsset(value, current = new URL(sourceOrigin)) {
  let url;
  try {
    url = new URL(value, current);
  } catch {
    return;
  }
  if (url.origin !== sourceOrigin) return;
  if (!url.pathname.startsWith("/_astro/") && !url.pathname.startsWith("/logos/")) return;
  if (assetKeys.has(url.pathname)) return;
  assetKeys.add(url.pathname);
  assetQueue.push(url);
}

function rewriteUrl(value, current) {
  if (!value || value.startsWith("#") || value.startsWith("mailto:") || value.startsWith("tel:")) return value;
  let url;
  try {
    url = new URL(value, current);
  } catch {
    return value;
  }
  if (![sourceOrigin, ...sourceAliases].some((origin) => url.origin === origin)) return value;
  if (excluded(url.pathname)) return `${basePath}/`;
  if (url.pathname.startsWith("/_astro/") || url.pathname.startsWith("/logos/")) {
    return `${basePath}${url.pathname}${url.search}${url.hash}`;
  }
  if ([...url.searchParams.keys()].every((key) => key === "page")) {
    return `${publicPath(url)}${url.hash}`;
  }
  return `${basePath}${url.pathname}${url.search}${url.hash}`;
}

function rewriteHtml(html, current) {
  for (const match of html.matchAll(/\b(?:href|src)=["']([^"']+)["']/g)) {
    const value = match[1];
    enqueueRoute(value, current);
    enqueueAsset(value, current);
  }
  let rewritten = html.replace(/\b(href|src|action)=(['"])([^'"]+)\2/g, (full, attr, quote, value) =>
    `${attr}=${quote}${rewriteUrl(value, current)}${quote}`,
  );
  for (const alias of sourceAliases) rewritten = rewritten.replaceAll(alias, `${targetOrigin}${basePath}`);
  const notice = `<div style="background:#111827;color:#fff;padding:8px 16px;text-align:center;font:600 13px/1.4 system-ui">Public access mirror. Scholarship data is synchronized from the canonical Scholarship Radar service.</div>`;
  return rewritten.replace(/<body([^>]*)>/i, `<body$1>${notice}`);
}

async function fetchOk(url) {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await fetch(url, { headers: { "user-agent": "ScholarshipRadarPublicMirror/1.0" } });
    if (response.ok) return response;
    lastStatus = response.status;
    if (response.status !== 429 && response.status < 500) break;
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
  }
  throw new Error(`${url} returned HTTP ${lastStatus} after bounded retries`);
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const sitemapResponse = await fetchOk(`${sourceOrigin}/sitemap.xml`);
const sitemap = await sitemapResponse.text();
for (const match of sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)) enqueueRoute(match[1]);
enqueueRoute("/");
enqueueRoute("/latest");

let routeIndex = 0;
while (routeIndex < routeQueue.length) {
  const url = routeQueue[routeIndex++];
  const response = await fetchOk(url);
  const contentType = response.headers.get("content-type") || "";
  let body = await response.text();
  if (contentType.includes("text/html")) body = rewriteHtml(body, url);
  else {
    for (const alias of sourceAliases) body = body.replaceAll(alias, `${targetOrigin}${basePath}`);
  }
  const destination = outputPath(url);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, body);
}

let assetIndex = 0;
while (assetIndex < assetQueue.length) {
  const url = assetQueue[assetIndex++];
  if (fetchedAssets.has(url.pathname)) continue;
  fetchedAssets.add(url.pathname);
  const response = await fetchOk(url);
  const contentType = response.headers.get("content-type") || "";
  let bytes = Buffer.from(await response.arrayBuffer());
  if (/text|javascript|json|svg/.test(contentType)) {
    let text = bytes.toString("utf8");
    for (const match of text.matchAll(/(?:url\(|from\s+|import\s*)["']?([^"')\s]+)["']?/g)) {
      enqueueAsset(match[1], url);
    }
    text = text.replaceAll('"/_astro/', `"${basePath}/_astro/`)
      .replaceAll("'/_astro/", `'${basePath}/_astro/`)
      .replaceAll('"/logos/', `"${basePath}/logos/`)
      .replaceAll("'/logos/", `'${basePath}/logos/`)
      .replaceAll('"/search', `"${basePath}/search`)
      .replaceAll('"/scholarships/', `"${basePath}/scholarships/`);
    bytes = Buffer.from(text);
  }
  const destination = join(outputRoot, url.pathname.replace(/^\//, ""));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
}

const api = await (await fetchOk(`${sourceOrigin}/api/scholarships.json`)).json();
if (!Array.isArray(api) || api.length < 100) throw new Error("Public catalog API did not return the expected collection");
await writeFile(join(outputRoot, "catalog-count.json"), `${JSON.stringify({ count: api.length, mirroredAt: new Date().toISOString() })}\n`);
await writeFile(join(outputRoot, ".nojekyll"), "");
await writeFile(join(outputRoot, "404.html"), await (await import("node:fs/promises")).readFile(join(outputRoot, "index.html")));

console.log(JSON.stringify({ routes: routeKeys.size, assets: fetchedAssets.size, scholarships: api.length, outputRoot }, null, 2));
