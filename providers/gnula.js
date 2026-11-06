/*
 * Gnula provider for Nuvio
 * Flow: Nuvio TMDB ID -> TMDB localized/original title -> Gnula directory
 *       -> available domain -> Gnula search -> validated ficha/episode
 *       -> Gnula player API -> SaveFiles HLS / Voe HLS
 *
 * Runtime: Nuvio-provided fetch. No npm dependencies.
 * Compatible style: Promise chains (no async/await).
 */

var PROVIDER_NAME = 'Gnula';
var TMDB_API_KEY = '56db0ec297530920213e1503706b81ff';
var TMDB_BASE = 'https://api.themoviedb.org/3';
var DIRECTORY_URL = 'https://dominiosgnulahd.com/';
var KNOWN_DOMAINS = [
  'https://ww3.gnulahd.nu',
  'https://gnulahd.click',
  'https://gnulahd.bid'
];

var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
var CACHE_TTL_MS = 10 * 60 * 1000;
var tmdbCache = Object.create(null);
var domainsCache = null;
var domainsCacheExpiresAt = 0;

function log(message) {
  console.log('[GnulaNuvio] ' + message);
}

function safeUrl(value) {
  try {
    var match = String(value || '').match(/^(https?:\/\/[^/]+)(\/[^?#]*)?/i);
    return match ? match[1] + (match[2] || '') : String(value || '');
  } catch (_) {
    return String(value || '');
  }
}

function requestText(url, headers, method, body) {
  return fetch(url, {
    method: method || 'GET',
    headers: Object.assign({
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8'
    }, headers || {}),
    body: body
  }).then(function (response) {
    return response.text().then(function (text) {
      if (!response.ok) throw new Error('HTTP ' + response.status + ' en ' + safeUrl(url));
      return text;
    });
  });
}

function requestJson(url, headers) {
  return fetch(url, {
    method: 'GET',
    headers: Object.assign({
      'User-Agent': UA,
      'Accept': 'application/json'
    }, headers || {})
  }).then(function (response) {
    return response.text().then(function (body) {
      var data;
      try { data = JSON.parse(body); } catch (_) { data = {}; }
      if (!response.ok) {
        throw new Error('HTTP ' + response.status + (data.status_message ? ': ' + data.status_message : ''));
      }
      return data;
    });
  });
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/gi, "'")
    .replace(/&#x0*27;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&aacute;/gi, 'á').replace(/&eacute;/gi, 'é')
    .replace(/&iacute;/gi, 'í').replace(/&oacute;/gi, 'ó')
    .replace(/&uacute;/gi, 'ú').replace(/&ntilde;/gi, 'ñ')
    .replace(/&Aacute;/g, 'Á').replace(/&Eacute;/g, 'É')
    .replace(/&Iacute;/g, 'Í').replace(/&Oacute;/g, 'Ó')
    .replace(/&Uacute;/g, 'Ú').replace(/&Ntilde;/g, 'Ñ')
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(Number(n)); })
    .replace(/&#x([0-9a-f]+);/gi, function (_, n) { return String.fromCharCode(parseInt(n, 16)); });
}

function stripTags(value) {
  return decodeEntities(String(value || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[\s\u00a0]+/g, ' ').trim();
}

function getAttribute(attributes, name) {
  var safeName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var match = String(attributes || '').match(new RegExp("(?:^|\\s)" + safeName + "\\s*=\\s*([\"'])([\\s\\S]*?)\\1", "i"));
  return match ? decodeEntities(match[2]) : '';
}

function absoluteUrl(base, value) {
  var url = decodeEntities(String(value || '').trim()).replace(/&amp;/g, '&');
  if (/^https?:\/\//i.test(url)) return url;
  if (url.indexOf('//') === 0) return 'https:' + url;
  return String(base || '').replace(/\/$/, '') + (url.charAt(0) === '/' ? url : '/' + url);
}

function getOrigin(url) {
  var match = String(url || '').match(/^(https?:\/\/[^/]+)/i);
  return match ? match[1] : '';
}

function normalizeTitle(value) {
  var text = String(value || '').toLowerCase();
  try { text = text.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (_) {}
  return text.replace(/&amp;/g, ' and ')
    .replace(/[’‘´`]/g, "'")
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function titleMatches(candidate, tmdbInfo) {
  var candidateTitle = normalizeTitle(candidate);
  if (!candidateTitle) return false;
  var possible = [tmdbInfo.title, tmdbInfo.original_title, tmdbInfo.name, tmdbInfo.original_name];
  for (var i = 0; i < possible.length; i++) {
    if (normalizeTitle(possible[i]) && normalizeTitle(possible[i]) === candidateTitle) return true;
  }
  return false;
}

function getTmdbInfo(tmdbId, mediaType) {
  var type = mediaType === 'movie' ? 'movie' : 'tv';
  var cacheKey = type + ':' + String(tmdbId);
  var now = Date.now();
  var cached = tmdbCache[cacheKey];
  if (cached && cached.expiresAt > now) return cached.promise;
  if (cached) delete tmdbCache[cacheKey];

  var entry = { expiresAt: now + CACHE_TTL_MS, promise: null };
  entry.promise = requestJson(
    TMDB_BASE + '/' + type + '/' + encodeURIComponent(String(tmdbId)) +
    '?api_key=' + encodeURIComponent(TMDB_API_KEY) + '&language=es-PE'
  ).then(function (data) {
    if (!data || !(data.title || data.name)) {
      throw new Error('TMDB no devolvió el título para ' + type + ' ' + tmdbId);
    }
    var yearSource = type === 'movie' ? data.release_date : data.first_air_date;
    var year = yearSource && /^\d{4}/.test(yearSource) ? yearSource.slice(0, 4) : '';
    return {
      title: data.title || '',
      original_title: data.original_title || '',
      name: data.name || '',
      original_name: data.original_name || '',
      year: year,
      mediaType: type
    };
  }).catch(function (error) {
    if (tmdbCache[cacheKey] === entry) delete tmdbCache[cacheKey];
    throw error;
  });

  tmdbCache[cacheKey] = entry;
  return entry.promise;
}

/* Read Gnula's current mirror list. The known list is only a fallback if the directory
   is unreachable or its HTML changes; candidate domains are always tested sequentially. */
function getGnulaDomains() {
  var now = Date.now();
  if (domainsCache && domainsCacheExpiresAt > now) return Promise.resolve(domainsCache);

  return requestText(DIRECTORY_URL, { 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' })
    .then(function (html) {
      var domains = [];
      var seen = Object.create(null);
      var anchors = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
      var match;
      while ((match = anchors.exec(html)) !== null) {
        var href = getAttribute(match[1], 'href');
        var hostMatch = href.match(/^https?:\/\/([^/:?#]+)/i);
        if (!hostMatch) continue;
        var host = hostMatch[1].toLowerCase().replace(/^www\./, '');
        if (host.indexOf('gnulahd.') === -1 || host === 'dominiosgnulahd.com') continue;
        var domain = 'https://' + host;
        if (!seen[domain]) {
          seen[domain] = true;
          domains.push(domain);
        }
      }
      if (!domains.length) domains = KNOWN_DOMAINS.slice(0);
      domainsCache = domains;
      domainsCacheExpiresAt = Date.now() + CACHE_TTL_MS;
      log('Dominios del directorio: ' + domains.join(' | '));
      return domains;
    }).catch(function (error) {
      log('No se pudo leer el directorio: ' + error.message + '; usando lista de respaldo.');
      domainsCache = KNOWN_DOMAINS.slice(0);
      domainsCacheExpiresAt = Date.now() + 2 * 60 * 1000;
      return domainsCache;
    });
}

function probeDomain(domain) {
  return requestText(domain + '/', { 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' })
    .then(function (html) {
      if (!/gnula|gnrd/i.test(html)) throw new Error('Respuesta no reconocida como Gnula');
      log('Dominio seleccionado: ' + domain);
      return domain;
    });
}

function extractSearchCards(html, base) {
  var cards = [];
  var anchorRx = /<a\b([^>]*\bclass\s*=\s*["'][^"']*\bgnrd-card\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi;
  var match;
  while ((match = anchorRx.exec(html)) !== null) {
    var attrs = match[1];
    var body = match[2];
    var titleMatch = body.match(/<span\b[^>]*\bclass\s*=\s*["'][^"']*\bgnrd-card-title\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
    var title = titleMatch ? stripTags(titleMatch[1]) : getAttribute(attrs, 'title');
    var yearMatch = body.match(/\b(19\d{2}|20\d{2})\b/);
    var href = getAttribute(attrs, 'href');
    if (!href || !title) continue;
    cards.push({
      title: title,
      url: absoluteUrl(base, href),
      year: yearMatch ? yearMatch[1] : '',
      html: body
    });
  }
  return cards;
}

function getClassText(html, className, tagName) {
  var tag = tagName || '[a-z][a-z0-9]*';
  var escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var rx = new RegExp("<(" + tag + ")\\b[^>]*\\bclass\\s*=\\s*[\"\'][^\"\']*\\b" + escaped + "\\b[^\"\']*[\"\'][^>]*>([\\s\\S]*?)<\\/\\1>", "i");
  var match = String(html || '').match(rx);
  return match ? stripTags(match[2]) : '';
}

function getFichaYear(html) {
  var eyebrow = getClassText(html, 'gnrd-eyebrow');
  var match = eyebrow.match(/\b(19\d{2}|20\d{2})\b/);
  if (match) return match[1];
  var published = html.match(/itemprop=["'](?:datePublished|dateCreated)["'][^>]*content=["'](\d{4})/i);
  if (published) return published[1];
  return '';
}

function fichaMatches(html, card, tmdbInfo) {
  var visibleTitle = getClassText(html, 'gnrd-fi-title', 'h1');
  var originalTitle = getClassText(html, 'gnrd-fi-orig');
  var titleAttr = '';
  var h1Tag = html.match(/<h1\b([^>]*)\bclass\s*=\s*["'][^"']*\bgnrd-fi-title\b[^"']*["'][^>]*>/i);
  if (h1Tag) titleAttr = getAttribute(h1Tag[1], 'title');

  var titleOk = titleMatches(visibleTitle, tmdbInfo) ||
    titleMatches(originalTitle, tmdbInfo) || titleMatches(titleAttr, tmdbInfo) ||
    titleMatches(card.title, tmdbInfo);
  if (!titleOk) return false;

  var pageYear = getFichaYear(html) || card.year;
  if (tmdbInfo.year && pageYear && tmdbInfo.year !== pageYear) {
    log('Ficha descartada por año: Gnula ' + pageYear + ' / TMDB ' + tmdbInfo.year + ' (' + card.title + ').');
    return false;
  }
  if (tmdbInfo.year && !pageYear) {
    log('La ficha no mostró año; se validó por título exacto.');
  }
  log('Ficha validada: ' + (visibleTitle || card.title) + ' (' + (pageYear || '?') + ')');
  return true;
}

function tryCandidateCards(cards, index, base, tmdbInfo) {
  if (index >= cards.length) return Promise.resolve(null);
  var card = cards[index];
  if (tmdbInfo.year && card.year && card.year !== tmdbInfo.year) {
    return tryCandidateCards(cards, index + 1, base, tmdbInfo);
  }

  return requestText(card.url, { 'Referer': base + '/' }).then(function (html) {
    if (fichaMatches(html, card, tmdbInfo)) return { url: card.url, html: html };
    return tryCandidateCards(cards, index + 1, base, tmdbInfo);
  }).catch(function (error) {
    log('No se pudo revisar ficha ' + card.url + ': ' + error.message);
    return tryCandidateCards(cards, index + 1, base, tmdbInfo);
  });
}

function searchTitleVariants(tmdbInfo) {
  var titles = [tmdbInfo.title || tmdbInfo.name, tmdbInfo.original_title || tmdbInfo.original_name];
  var unique = [];
  var seen = Object.create(null);
  titles.forEach(function (title) {
    var value = String(title || '').trim();
    var key = normalizeTitle(value);
    if (value && key && !seen[key]) {
      seen[key] = true;
      unique.push(value);
    }
  });
  return unique;
}

function findMatchingFicha(base, tmdbInfo) {
  var queries = searchTitleVariants(tmdbInfo);
  function tryQuery(index) {
    if (index >= queries.length) return Promise.resolve(null);
    var query = queries[index];
    var searchUrl = base + '/?s=' + encodeURIComponent(query);
    log('Búsqueda Gnula: ' + query);
    return requestText(searchUrl, { 'Referer': base + '/' }).then(function (html) {
      var cards = extractSearchCards(html, base);
      log('Resultados para "' + query + '": ' + cards.length);
      return tryCandidateCards(cards, 0, base, tmdbInfo).then(function (found) {
        return found || tryQuery(index + 1);
      });
    });
  }
  return tryQuery(0);
}

function findEpisodeUrl(seriesHtml, base, season, episode) {
  var anchors = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  var match;
  var seasonText = String(season);
  var episodeText = String(episode);
  var patterns = [
    new RegExp('(?:^|[^0-9])0?' + seasonText + '\\s*x\\s*0?' + episodeText + '(?:[^0-9]|$)', 'i'),
    new RegExp('s0*' + seasonText + '[ ._-]*e0*' + episodeText + '(?:[^0-9]|$)', 'i')
  ];

  while ((match = anchors.exec(seriesHtml)) !== null) {
    var attrs = match[1];
    var href = getAttribute(attrs, 'href');
    if (!href) continue;
    var searchable = stripTags(match[2]) + ' ' + getAttribute(attrs, 'title') + ' ' +
      getAttribute(attrs, 'aria-label') + ' ' + href;
    var found = patterns.some(function (pattern) { return pattern.test(searchable); });
    if (!found) continue;
    var episodeUrl = absoluteUrl(base, href);
    log('Episodio localizado: S' + season + 'E' + episode + ' -> ' + safeUrl(episodeUrl));
    return episodeUrl;
  }
  return null;
}

function getContentPlayerPage(base, ficha, tmdbInfo, season, episode) {
  if (tmdbInfo.mediaType === 'movie') {
    return Promise.resolve({ url: ficha.url, html: ficha.html });
  }
  var episodeUrl = findEpisodeUrl(ficha.html, base, season, episode);
  if (!episodeUrl) {
    log('Gnula no mostró un enlace para S' + season + 'E' + episode + '.');
    return Promise.resolve(null);
  }
  return requestText(episodeUrl, { 'Referer': ficha.url }).then(function (html) {
    return { url: episodeUrl, html: html };
  });
}

function decodeUtf8Binary(binary) {
  var encoded = '';
  for (var i = 0; i < binary.length; i++) {
    var hex = binary.charCodeAt(i).toString(16);
    encoded += '%' + (hex.length < 2 ? '0' : '') + hex;
  }
  try { return decodeURIComponent(encoded); }
  catch (_) { return binary; }
}

/* Replica gnrdUnpack(): Base64 -> XOR cíclico [103,78,55,100] -> JSON. */
function unpackGnulaPayload(encoded) {
  if (!encoded || typeof encoded !== 'string') throw new Error('Gnula no devolvió el campo player "p".');
  var binary = atob(encoded);
  var key = [103, 78, 55, 100];
  var decoded = '';
  for (var i = 0; i < binary.length; i++) {
    decoded += String.fromCharCode(binary.charCodeAt(i) ^ key[i % key.length]);
  }
  return JSON.parse(decodeUtf8Binary(decoded));
}

function getPlayerData(pageUrl, html) {
  var pidMatch = html.match(/\b_gnrdPid\s*=\s*(\d+)/);
  var tokenMatch = html.match(/\b_gnrdTok\s*=\s*(['"])([a-fA-F0-9]+)\1/);
  if (!pidMatch || !tokenMatch) {
    throw new Error('No se encontraron _gnrdPid/_gnrdTok en la ficha o episodio de Gnula.');
  }

  var base = getOrigin(pageUrl);
  var apiUrl = base + '/wp-json/gnrd/v1/player?id=' + encodeURIComponent(pidMatch[1]) +
    '&t=' + encodeURIComponent(tokenMatch[2]);
  log('API player Gnula: ' + safeUrl(apiUrl));

  return requestJson(apiUrl, {
    'Referer': pageUrl,
    'Origin': base
  }).then(function (raw) {
    var unpacked = unpackGnulaPayload(raw && raw.p ? raw.p : '');
    if (!unpacked || !Array.isArray(unpacked.langs)) {
      throw new Error('La API de Gnula no devolvió la lista de idiomas/servidores esperada.');
    }
    return unpacked;
  });
}

function parseSaveFilesCode(embedUrl) {
  var match = String(embedUrl || '').match(/\/e\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]) : '';
}

/* SaveFiles: GET embed (cookies/session), POST /dl (op=embed), extract JWPlayer sources[].file. */
function extractSaveFiles(embedUrl, gnulaPageUrl) {
  var origin = getOrigin(embedUrl);
  var code = parseSaveFilesCode(embedUrl);
  if (!origin || !code) return Promise.reject(new Error('URL SaveFiles no reconocida.'));

  return requestText(embedUrl, {
    'Referer': gnulaPageUrl,
    'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8'
  }).then(function () {
    var form = 'op=embed&file_code=' + encodeURIComponent(code) +
      '&auto=1&referer=' + encodeURIComponent(gnulaPageUrl);
    return requestText(origin + '/dl', {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Origin': origin,
      'Referer': gnulaPageUrl,
      'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8'
    }, 'POST', form);
  }).then(function (html) {
    var hlsMatch = html.match(/["']file["']\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i) ||
      html.match(/\bfile\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i) ||
      html.match(/https?:\\?\/\\?\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i);
    if (!hlsMatch) throw new Error('SaveFiles no devolvió una fuente HLS en /dl.');

    var hlsUrl = hlsMatch[1] || hlsMatch[0];
    hlsUrl = hlsUrl.replace(/\\\//g, '/').replace(/&amp;/g, '&');
    if (!/^https?:\/\//i.test(hlsUrl)) throw new Error('SaveFiles devolvió una URL HLS inválida.');
    return { url: hlsUrl, headers: {}, type: 'hls' };
  });
}

var VOE_MARKERS = ['@$', '^^', '~@', '%?', '*~', '!!', '#&'];

/* Resolver Voe preservado de la plantilla animenuvio.js. */
function decodeVoePayload(rawValue) {
  var value = String(rawValue || '').replace(/[a-zA-Z]/g, function (char) {
    var code = char.charCodeAt(0);
    var base = code <= 90 ? 65 : 97;
    return String.fromCharCode((code - base + 13) % 26 + base);
  });
  VOE_MARKERS.forEach(function (marker) {
    value = value.split(marker).join('_');
  });
  value = value.split('_').join('');
  value = atob(value);
  value = Array.from(value).map(function (char) {
    return String.fromCharCode((char.charCodeAt(0) - 3 + 256) % 256);
  }).join('');
  value = value.split('').reverse().join('');
  return JSON.parse(atob(value));
}

function extractVoe(embedUrl) {
  /* Keep the original Voe request headers unchanged: User-Agent only. */
  return fetch(embedUrl, { headers: { 'User-Agent': UA } }).then(function (response) {
    if (!response.ok) throw new Error('HTTP ' + response.status + ' en Voe');
    return response.text();
  }).then(function (html) {
    var redirect = html.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/);
    if (!redirect) return html;
    log('Voe redirección JS detectada');
    return fetch(redirect[1], { headers: { 'User-Agent': UA } }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status + ' en redirección Voe');
      return response.text();
    });
  }).then(function (html) {
    var script = html.match(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/i);
    if (!script) throw new Error('Voe: no se encontró application/json');

    var jsonText = script[1].trim()
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
      .replace(/&#34;/g, '"').replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>');

    var payload;
    try { payload = JSON.parse(jsonText); }
    catch (_) { throw new Error('Voe: JSON del embed inválido'); }
    if (!Array.isArray(payload) || !payload[0]) throw new Error('Voe: payload vacío');

    var decoded = decodeVoePayload(payload[0]);
    if (!decoded || !decoded.source || !/^https?:\/\//i.test(decoded.source)) {
      throw new Error('Voe: el payload no contiene source HLS');
    }

    var origin = getOrigin(embedUrl);
    return {
      url: decoded.source,
      headers: {
        'Referer': origin ? origin + '/' : embedUrl,
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty',
        'User-Agent': UA
      },
      type: 'hls'
    };
  });
}

function getServerKind(server) {
  var host = getOrigin(server && server.src).toLowerCase();
  if (host.indexOf('savefiles.com') !== -1) return 'savefiles';
  if (host.indexOf('voe.') !== -1 || host.indexOf('voe.sx') !== -1) return 'voe';
  return '';
}

function getLanguageLabel(language) {
  var label = String(language && (language.label || language.name || language.lang) || '').toLowerCase();
  if (label.indexOf('latino') !== -1 || label.indexOf('latam') !== -1) return '🇲🇽 LATINO';
  if (label.indexOf('sub') !== -1) return '🇺🇸 SUBTITULADO';
  if (label.indexOf('castellano') !== -1 || label.indexOf('cast') !== -1) return '🇪🇸 CASTELLANO';
  return String(language && (language.label || language.name || language.lang) || 'IDIOMA').toUpperCase();
}

function resolveOneServer(server, language, pageUrl, mediaType, season, episode) {
  var kind = getServerKind(server);
  var sourceUrl = server && server.src;
  if (!kind || !sourceUrl) return Promise.resolve(null);

  var label = kind === 'savefiles' ? 'SaveFiles' : 'Voe';
  var resolver = kind === 'savefiles'
    ? extractSaveFiles(sourceUrl, pageUrl)
    : extractVoe(sourceUrl);

  return resolver.then(function (resolved) {
    var mediaLabel = mediaType === 'tv'
      ? 'Serie S' + season + 'E' + episode
      : 'Película';
    return {
      name: PROVIDER_NAME,
      title: label + ' · ' + (language.label || language.name || 'Video'),
      url: resolved.url,
      quality: '📺 ' + label + ' HLS\n720p | WEB-DL | ' + mediaLabel + '\n' + getLanguageLabel(language),
      headers: resolved.headers || {},
      type: 'hls'
    };
  }).catch(function (error) {
    log(label + ' (' + (language.label || 'sin idioma') + ') falló: ' + error.message);
    return null;
  });
}

function extractGnulaStreams(playerData, pageUrl, mediaType, season, episode) {
  var langs = playerData && Array.isArray(playerData.langs) ? playerData.langs : [];
  var pending = [];

  langs.forEach(function (language) {
    var servers = language && Array.isArray(language.servers) ? language.servers.slice(0) : [];
    servers.sort(function (a, b) {
      var pa = getServerKind(a) === 'savefiles' ? 0 : (getServerKind(a) === 'voe' ? 1 : 2);
      var pb = getServerKind(b) === 'savefiles' ? 0 : (getServerKind(b) === 'voe' ? 1 : 2);
      return pa - pb;
    });

    servers.forEach(function (server) {
      if (getServerKind(server)) {
        pending.push(resolveOneServer(server, language, pageUrl, mediaType, season, episode));
      }
    });
  });

  if (!pending.length) {
    log('La ficha no ofrece servidores SaveFiles ni Voe.');
    return Promise.resolve([]);
  }

  return Promise.all(pending).then(function (streams) {
    var seen = Object.create(null);
    return streams.filter(function (stream) {
      if (!stream || !stream.url || seen[stream.url]) return false;
      seen[stream.url] = true;
      return true;
    });
  });
}

function resolveOnDomain(domain, tmdbInfo, mediaType, season, episode) {
  return requestText(domain + '/', { 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' })
    .then(function (homeHtml) {
      if (!/gnula|gnrd/i.test(homeHtml)) throw new Error('El dominio no devolvió una página Gnula válida.');
      log('Dominio seleccionado: ' + domain);
      return findMatchingFicha(domain, tmdbInfo);
    }).then(function (ficha) {
      if (!ficha) {
        log('No se encontró una ficha validada en el dominio seleccionado.');
        return [];
      }
      return getContentPlayerPage(domain, ficha, tmdbInfo, season, episode);
    }).then(function (playerPage) {
      if (!playerPage) return [];
      return getPlayerData(playerPage.url, playerPage.html).then(function (playerData) {
        log('Idiomas disponibles: ' + playerData.langs.length);
        return extractGnulaStreams(playerData, playerPage.url, mediaType, season, episode);
      });
    });
}

function tryDomains(domains, index, tmdbInfo, mediaType, season, episode) {
  if (index >= domains.length) {
    return Promise.reject(new Error('Fallaron todos los dominios Gnula disponibles.'));
  }
  return resolveOnDomain(domains[index], tmdbInfo, mediaType, season, episode).catch(function (error) {
    log('Falló el dominio ' + domains[index] + ': ' + error.message + '; probando el siguiente.');
    return tryDomains(domains, index + 1, tmdbInfo, mediaType, season, episode);
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  var type = String(mediaType || '').toLowerCase();
  if (!tmdbId || (type !== 'movie' && type !== 'tv')) return Promise.resolve([]);

  var seasonNumber = type === 'tv' ? Number(season) : 1;
  var episodeNumber = type === 'tv' ? Number(episode) : 1;
  if (type === 'tv' && (!Number.isInteger(seasonNumber) || seasonNumber < 0 ||
      !Number.isInteger(episodeNumber) || episodeNumber < 1)) {
    log('Temporada o episodio inválido; se omiten las consultas.');
    return Promise.resolve([]);
  }
  if (!TMDB_API_KEY) {
    log('Falta configurar la API Key de TMDB.');
    return Promise.resolve([]);
  }

  log('Solicitud Nuvio: TMDB ' + type + ' ' + tmdbId +
    (type === 'tv' ? ' S' + seasonNumber + 'E' + episodeNumber : ''));

  return getTmdbInfo(tmdbId, type).then(function (tmdbInfo) {
    log('TMDB: ' + (tmdbInfo.title || tmdbInfo.name) +
      (tmdbInfo.year ? ' (' + tmdbInfo.year + ')' : '') +
      (tmdbInfo.original_title || tmdbInfo.original_name
        ? ' | Original: ' + (tmdbInfo.original_title || tmdbInfo.original_name) : ''));
    return getGnulaDomains().then(function (domains) {
      return tryDomains(domains, 0, tmdbInfo, type, seasonNumber, episodeNumber);
    });
  }).then(function (streams) {
    log('Streams HLS devueltos: ' + streams.length);
    return streams;
  }).catch(function (error) {
    console.error('[GnulaNuvio] ' + (error && error.message ? error.message : String(error)));
    return [];
  });
}

module.exports = { getStreams: getStreams };
