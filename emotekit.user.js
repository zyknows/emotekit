// ==UserScript==
// @name         EmoteKit for Twitch
// @namespace    https://github.com/zyknows/emotekit
// @version      0.3.0
// @description  Shows BetterTTV, FrankerFaceZ and 7TV emotes in Twitch chat.
// @author       Volkan
// @license      MIT
// @homepageURL  https://github.com/zyknows/emotekit
// @supportURL   https://github.com/zyknows/emotekit/issues
// @downloadURL  https://raw.githubusercontent.com/zyknows/emotekit/main/emotekit.user.js
// @updateURL    https://raw.githubusercontent.com/zyknows/emotekit/main/emotekit.user.js
// @match        https://www.twitch.tv/*
// @match        https://twitch.tv/*
// @run-at       document-end
// @inject-into  content
// @grant        GM.xmlHttpRequest
// @grant        GM_xmlhttpRequest
// @connect      api.betterttv.net
// @connect      api.frankerfacez.com
// @connect      7tv.io
// @connect      gql.twitch.tv
// @connect      api.ivr.fi
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------

  const CONFIG = {
    providers: { bttv: true, ffz: true, seventv: true },
    emoteHeight: 28, // px, matches Twitch's native chat emotes
  };

  const TAG = '[EmoteKit]';
  const DEBUG = (() => {
    try { return localStorage.getItem('emotekit:debug') === '1'; } catch { return false; }
  })();
  const debug = (...a) => { if (DEBUG) console.log(TAG, ...a); };
  const warn = (...a) => console.warn(TAG, ...a);

  // Public client ID used by twitch.tv's own web app for its GraphQL API.
  const TWITCH_GQL = 'https://gql.twitch.tv/gql';
  const TWITCH_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

  // First path segments on twitch.tv that are not channel names.
  const RESERVED_PATHS = new Set([
    'directory', 'settings', 'subscriptions', 'inventory', 'wallet', 'drops',
    'search', 'downloads', 'jobs', 'p', 'turbo', 'prime', 'friends', 'messages',
    'payments', 'login', 'signup', 'logout', 'store', 'bits', 'following',
    'creatorcamp', 'broadcast', 'u', 'team', 'collections', 'event', 'products',
  ]);

  // BetterTTV global emotes that sit on top of the previous emote.
  const BTTV_OVERLAYS = new Set([
    'IceCold', 'SoSnowy', 'TopHat', 'SantaHat', 'ReinDeer', 'CandyCane', 'cvMask', 'cvHazmat',
  ]);

  // ---------------------------------------------------------------------------
  // Networking
  // ---------------------------------------------------------------------------

  function getGmRequest() {
    if (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function') {
      return GM.xmlHttpRequest.bind(GM);
    }
    if (typeof GM_xmlhttpRequest === 'function') return GM_xmlhttpRequest;
    return null;
  }

  function gmRequest(gm, url, opts) {
    return new Promise((resolve, reject) => {
      gm({
        method: opts.method || 'GET',
        url,
        headers: opts.headers,
        data: opts.body,
        timeout: 15000,
        onload: (r) => resolve({ status: r.status, text: r.responseText ?? r.response }),
        onerror: () => reject(new Error(`Network error: ${url}`)),
        ontimeout: () => reject(new Error(`Timed out: ${url}`)),
      });
    });
  }

  // Returns parsed JSON, or null on 404 (e.g. a channel with no BTTV account).
  async function requestJSON(url, opts = {}) {
    const gm = getGmRequest();
    let res;
    if (gm) {
      res = await gmRequest(gm, url, opts);
    } else {
      const r = await fetch(url, { method: opts.method || 'GET', headers: opts.headers, body: opts.body });
      res = { status: r.status, text: await r.text() };
    }
    if (res.status === 404) return null;
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}: ${url}`);
    return typeof res.text === 'string' ? JSON.parse(res.text) : res.text;
  }

  function absUrl(u) {
    if (!u || typeof u !== 'string') return null;
    return u.startsWith('//') ? `https:${u}` : u;
  }

  // ---------------------------------------------------------------------------
  // Provider parsers (pure: API JSON in, emote list out)
  // Emote shape: { key, code, provider, source, url1x, url2x, zeroWidth }
  // `key` (provider + the service's emote ID) identifies one image across channels.
  // ---------------------------------------------------------------------------

  function parseBttv(list, source) {
    if (!Array.isArray(list)) return [];
    return list
      // modifier: true marks BTTV text modifiers (w!, h!, z!...), which change the next emote rather than render.
      .filter((e) => e && e.id && e.code && e.modifier !== true)
      .map((e) => ({
        key: `BTTV:${e.id}`,
        code: e.code,
        provider: 'BTTV',
        source,
        url1x: `https://cdn.betterttv.net/emote/${e.id}/1x`,
        url2x: `https://cdn.betterttv.net/emote/${e.id}/2x`,
        zeroWidth: source === 'Global' && BTTV_OVERLAYS.has(e.code),
      }));
  }

  function parseBttvChannel(data) {
    if (!data) return [];
    return [
      ...parseBttv(data.channelEmotes, 'Channel'),
      ...parseBttv(data.sharedEmotes, 'Channel'),
    ];
  }

  function parseFfzSets(sets, setIds, source) {
    if (!sets || typeof sets !== 'object') return [];
    const ids = Array.isArray(setIds) ? setIds.map(String) : Object.keys(sets);
    const out = [];
    for (const id of ids) {
      const set = sets[id];
      if (!set || !Array.isArray(set.emoticons)) continue;
      for (const e of set.emoticons) {
        if (!e || !e.name) continue;
        // Modifier flag 1 = hidden: an effect like ffzW/ffzX that transforms the previous emote, not an image.
        if (e.modifier === true && (e.modifier_flags & 1)) continue;
        const urls = e.animated || e.urls || {};
        const url1x = absUrl(urls['1']);
        if (!url1x) continue;
        out.push({
          key: `FFZ:${e.id != null ? e.id : e.name}`,
          code: e.name,
          provider: 'FFZ',
          source,
          url1x,
          url2x: absUrl(urls['2']) || null,
          zeroWidth: e.modifier === true,
        });
      }
    }
    return out;
  }

  function parseFfzGlobal(data) {
    if (!data) return [];
    return parseFfzSets(data.sets, data.default_sets, 'Global');
  }

  function parseFfzRoom(data) {
    if (!data) return [];
    return parseFfzSets(data.sets, null, 'Channel');
  }

  function parse7tv(emotes, source) {
    if (!Array.isArray(emotes)) return [];
    const out = [];
    for (const e of emotes) {
      const host = e && e.data && e.data.host;
      const base = host && absUrl(host.url);
      if (!e || !e.name || !base) continue;
      const files = Array.isArray(host.files) ? host.files.map((f) => f && f.name) : [];
      const pick = (scale) => {
        const name = [`${scale}.webp`, `${scale}.avif`, `${scale}.gif`, `${scale}.png`]
          .find((n) => files.length === 0 || files.includes(n));
        return name ? `${base}/${name}` : null;
      };
      const url1x = pick('1x');
      if (!url1x) continue;
      const zeroWidth = ((e.flags || 0) & 1) === 1 || ((e.data.flags || 0) & 256) === 256;
      out.push({ key: `7TV:${e.id || e.data.id || e.name}`, code: e.name, provider: '7TV', source, url1x, url2x: pick('2x'), zeroWidth });
    }
    return out;
  }

  function parse7tvGlobal(data) {
    return data ? parse7tv(data.emotes, 'Global') : [];
  }

  function parse7tvUser(data) {
    return data && data.emote_set ? parse7tv(data.emote_set.emotes, 'Channel') : [];
  }

  // Later lists win on name clashes: channel beats global, 7TV beats BTTV beats FFZ.
  function buildMap(lists) {
    const map = new Map();
    for (const list of lists) for (const e of list) map.set(e.code, e);
    return map;
  }

  // ---------------------------------------------------------------------------
  // Routing: figure out which channel's chat is on screen
  // ---------------------------------------------------------------------------

  function channelFromPath(pathname) {
    const parts = pathname.split('/').filter(Boolean).map((p) => {
      try { return decodeURIComponent(p); } catch { return p; }
    });
    if (parts.length === 0) return null;
    const first = parts[0].toLowerCase();
    const second = parts[1];

    if (first === 'popout' || first === 'embed' || first === 'moderator') {
      return isLogin(second) ? { login: second.toLowerCase() } : null;
    }
    if (first === 'videos') {
      const id = (second || '').replace(/^v/, '');
      return /^\d+$/.test(id) ? { vodId: id } : null;
    }
    if (RESERVED_PATHS.has(first)) return null;
    return isLogin(parts[0]) ? { login: first } : null;
  }

  function isLogin(s) {
    return typeof s === 'string' && /^[a-zA-Z0-9_]{1,25}$/.test(s);
  }

  function routeKey(target) {
    if (!target) return null;
    return target.login ? `c:${target.login}` : `v:${target.vodId}`;
  }

  async function twitchGql(query, variables) {
    const json = await requestJSON(TWITCH_GQL, {
      method: 'POST',
      headers: { 'Client-Id': TWITCH_CLIENT_ID, 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ query, variables }),
    });
    return json && json.data;
  }

  const channelIdCache = new Map(); // routeKey -> { id, login }

  async function resolveChannel(target) {
    const key = routeKey(target);
    if (channelIdCache.has(key)) return channelIdCache.get(key);

    let result = null;
    if (target.login) {
      try {
        const data = await twitchGql('query($login:String!){user(login:$login){id login}}', { login: target.login });
        if (data && data.user) result = { id: data.user.id, login: data.user.login };
      } catch (err) {
        debug('GQL lookup failed, trying fallback', err);
      }
      if (!result) {
        const data = await requestJSON(`https://api.ivr.fi/v2/twitch/user?login=${encodeURIComponent(target.login)}`);
        const user = Array.isArray(data) ? data[0] : null;
        if (user && user.id) result = { id: String(user.id), login: user.login };
      }
    } else if (target.vodId) {
      const data = await twitchGql('query($id:ID!){video(id:$id){owner{id login}}}', { id: target.vodId });
      const owner = data && data.video && data.video.owner;
      if (owner) result = { id: owner.id, login: owner.login };
    }

    if (result) channelIdCache.set(key, result);
    return result;
  }

  // ---------------------------------------------------------------------------
  // Emote loading
  // ---------------------------------------------------------------------------

  const state = {
    map: new Map(), // code -> emote shown in chat (hidden emotes left out)
    hiddenWords: new Map(), // code -> emote the user hid; the word shows as clickable text
    full: new Map(), // code -> emote by precedence, hidden or not (for the picker's hide mode)
    all: new Map(), // key -> every emote available here, including shadowed ones
    lists: [], // [globals, channel] as loaded, so the map can be rebuilt
    globals: null,
    globalsPromise: null,
    channelCache: new Map(), // twitch user id -> emote list
    routeKey: undefined,
    routeToken: 0,
    mapVersion: 0, // bumped whenever the emote map changes, so the picker knows to rebuild
  };

  async function settledLists(jobs) {
    const results = await Promise.allSettled(jobs.map(([name, fn]) => fn().then((list) => [name, list])));
    const lists = [];
    let ok = 0;
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') { lists.push(r.value[1]); ok++; } else warn(`${jobs[i][0]} failed:`, r.reason && r.reason.message);
    });
    return { lists, ok };
  }

  function ensureGlobals() {
    if (state.globals) return Promise.resolve(state.globals);
    if (state.globalsPromise) return state.globalsPromise;
    const p = CONFIG.providers;
    const jobs = [];
    if (p.ffz) jobs.push(['FFZ globals', async () => parseFfzGlobal(await requestJSON('https://api.frankerfacez.com/v1/set/global'))]);
    if (p.bttv) jobs.push(['BTTV globals', async () => parseBttv(await requestJSON('https://api.betterttv.net/3/cached/emotes/global'), 'Global')]);
    if (p.seventv) jobs.push(['7TV globals', async () => parse7tvGlobal(await requestJSON('https://7tv.io/v3/emote-sets/global'))]);

    state.globalsPromise = settledLists(jobs).then(({ lists, ok }) => {
      const flat = lists.flat();
      // Only cache when every provider answered, so a hiccup gets retried on the next channel.
      if (ok === jobs.length) state.globals = flat;
      state.globalsPromise = null;
      return flat;
    });
    return state.globalsPromise;
  }

  async function loadChannel(twitchId) {
    if (state.channelCache.has(twitchId)) return state.channelCache.get(twitchId);
    const p = CONFIG.providers;
    const id = encodeURIComponent(twitchId);
    const jobs = [];
    if (p.ffz) jobs.push(['FFZ channel', async () => parseFfzRoom(await requestJSON(`https://api.frankerfacez.com/v1/room/id/${id}`))]);
    if (p.bttv) jobs.push(['BTTV channel', async () => parseBttvChannel(await requestJSON(`https://api.betterttv.net/3/cached/users/twitch/${id}`))]);
    if (p.seventv) jobs.push(['7TV channel', async () => parse7tvUser(await requestJSON(`https://7tv.io/v3/users/twitch/${id}`))]);

    const { lists, ok } = await settledLists(jobs);
    const flat = lists.flat();
    if (ok === jobs.length) state.channelCache.set(twitchId, flat);
    return flat;
  }

  async function handleRoute() {
    const target = channelFromPath(location.pathname);
    const key = routeKey(target);
    if (key === state.routeKey) return;
    state.routeKey = key;
    const token = ++state.routeToken;

    const globals = await ensureGlobals();
    let channel = [];
    let label = 'no channel';
    let channelId = null;
    if (target) {
      try {
        const ch = await resolveChannel(target);
        if (ch) {
          label = ch.login;
          channelId = ch.id;
          channel = await loadChannel(ch.id);
        } else {
          warn(`Could not find a Twitch user for ${key}`);
        }
      } catch (err) {
        warn('Channel emotes failed:', err && err.message);
      }
    }
    if (token !== state.routeToken) return; // user navigated away meanwhile

    loadUsage(channelId);
    state.lists = [globals, channel];
    applyEmoteLists();
    closePicker();
    closeEmoteMenu();
    console.info(TAG, `${state.map.size} emotes ready (${channel.length} from ${label})`);
    rescan();
  }

  // Splits the loaded emotes into those shown in chat and those the user hid. A hidden
  // emote's word stays text, even if another service has an emote of the same name.
  function applyEmoteLists() {
    state.all = new Map();
    for (const list of state.lists) for (const e of list) state.all.set(e.key, e);
    state.full = buildMap(state.lists);
    state.map = new Map();
    state.hiddenWords = new Map();
    for (const [code, e] of state.full) (hidden.has(e.key) ? state.hiddenWords : state.map).set(code, e);
    state.mapVersion++;
  }

  // ---------------------------------------------------------------------------
  // Settings and stats, kept in this browser's localStorage for twitch.tv
  // ---------------------------------------------------------------------------

  const store = {
    get(name, fallback) {
      try {
        const v = localStorage.getItem(`emotekit:${name}`);
        return v === null ? fallback : JSON.parse(v);
      } catch { return fallback; }
    },
    set(name, value) {
      try { localStorage.setItem(`emotekit:${name}`, JSON.stringify(value)); } catch { /* full or blocked */ }
    },
    remove(name) {
      try { localStorage.removeItem(`emotekit:${name}`); } catch { /* blocked */ }
    },
    // A saved list, or [] if it's missing or damaged.
    list(name) {
      const v = this.get(name, []);
      return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
    },
  };

  // Emotes the user turned off (by key). They show as plain text in chat.
  const hidden = new Set(store.list('hidden'));

  function setHidden(key, on) {
    if (on === hidden.has(key)) return;
    if (on) hidden.add(key); else hidden.delete(key);
    store.set('hidden', [...hidden]);
    onHiddenChanged();
  }

  function onHiddenChanged() {
    applyEmoteLists();
    refreshChat();
    if (!pickerIsOpen()) return;
    if (picker.hideMode) syncHiddenItems();
    else renderPicker({ keepScroll: true });
  }

  // How often each emote shows up in this channel's chat, for "Popular here" and ranking.
  // Scores halve every week, so the list follows what the channel uses now.
  const USAGE_HALF_LIFE = 7 * 24 * 3600 * 1000;
  const USAGE_KEEP = 500; // emotes per channel
  // twitch.tv's localStorage is shared with Twitch's own settings (about 5 MB in total), so
  // only the channels watched most recently keep their stats.
  const USAGE_CHANNELS = 40;
  const usage = { channel: null, scores: new Map(), dirty: false, timer: null };

  function loadUsage(channelId) {
    if (usage.channel === channelId) return;
    saveUsage();
    usage.channel = channelId;
    usage.scores = new Map();
    if (!channelId) return;
    const saved = store.get(`usage:${channelId}`, null);
    if (!saved || !saved.s || typeof saved.s !== 'object') return;
    const decay = Math.pow(0.5, Math.max(0, Date.now() - (Number(saved.t) || 0)) / USAGE_HALF_LIFE);
    for (const [key, n] of Object.entries(saved.s)) if (typeof n === 'number' && n > 0) usage.scores.set(key, n * decay);
  }

  function countUsage(key) {
    if (!usage.channel) return;
    usage.scores.set(key, (usage.scores.get(key) || 0) + 1);
    usage.dirty = true;
    if (!usage.timer) usage.timer = setTimeout(saveUsage, 15000);
  }

  function saveUsage() {
    clearTimeout(usage.timer);
    usage.timer = null;
    if (!usage.channel || !usage.dirty) return;
    const top = [...usage.scores].filter(([, v]) => v >= 0.05).sort((a, b) => b[1] - a[1]).slice(0, USAGE_KEEP);
    store.set(`usage:${usage.channel}`, { t: Date.now(), s: Object.fromEntries(top.map(([k, v]) => [k, Math.round(v * 100) / 100])) });
    usage.dirty = false;
    const index = store.get('usage-index', {});
    const channels = index && typeof index === 'object' && !Array.isArray(index) ? index : {};
    channels[usage.channel] = Date.now();
    const byAge = Object.entries(channels).sort((a, b) => b[1] - a[1]);
    for (const [old] of byAge.slice(USAGE_CHANNELS)) {
      store.remove(`usage:${old}`);
      delete channels[old];
    }
    store.set('usage-index', channels);
  }

  function score(e) {
    return usage.scores.get(e.key) || 0;
  }

  // Sort helper: favourites (0) before the rest (1).
  function fav(e) {
    return isFavourite(e.key) ? 0 : 1;
  }

  // Emotes the user starred (by key, in the order they were added; shared by all channels).
  let favourites = store.list('favourites');

  function isFavourite(key) {
    return favourites.includes(key);
  }

  function setFavourite(key, on) {
    if (on === isFavourite(key)) return;
    favourites = on ? [...favourites, key] : favourites.filter((k) => k !== key);
    store.set('favourites', favourites);
    if (pickerIsOpen() && !picker.hideMode) renderPicker({ keepScroll: true });
  }

  function installStorageSync() {
    window.addEventListener('storage', onStorage);
    window.addEventListener('pagehide', saveUsage);
    document.addEventListener('visibilitychange', () => { if (document.hidden) saveUsage(); });
  }

  // Another tab changed the hidden emotes or favourites.
  function onStorage(ev) {
    if (ev.key === 'emotekit:hidden') {
      hidden.clear();
      for (const k of store.list('hidden')) hidden.add(k);
      onHiddenChanged();
    } else if (ev.key === 'emotekit:favourites') {
      favourites = store.list('favourites');
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  // Live chat, popout chat and VOD chat replay all put plain message text in these spans.
  const FRAGMENT_SELECTOR = '[data-a-target="chat-message-text"], .text-fragment';

  // `deferred` leaves the image unloaded until loadImage() is called (used by the picker).
  function makeEmote(e, deferred = false) {
    const wrap = document.createElement('span');
    wrap.className = 'emotekit-emote';
    wrap.dataset.emotekit = e.code;
    wrap.appendChild(makeImg(e, false, deferred));
    return wrap;
  }

  function makeImg(e, overlay, deferred = false) {
    const img = document.createElement('img');
    img.className = overlay ? 'emotekit-img emotekit-overlay' : 'emotekit-img';
    img.dataset.src = e.url1x;
    if (e.url2x) img.dataset.srcset = `${e.url1x} 1x, ${e.url2x} 2x`;
    if (!deferred) loadImage(img);
    img.alt = e.code; // copying chat text keeps the emote name
    img.decoding = 'async';
    img.dataset.key = e.key;
    img.dataset.provider = e.provider; // read by the tooltip
    img.dataset.source = e.source;
    img.dataset.large = e.url2x || e.url1x;
    return img;
  }

  // A hidden emote's name. Click it to show the emote again.
  function makeHiddenWord(e) {
    const span = document.createElement('span');
    span.className = 'emotekit-hidden-word';
    span.dataset.key = e.key;
    span.textContent = e.code;
    return span;
  }

  function loadImage(img) {
    if (img.dataset.srcset) img.srcset = img.dataset.srcset;
    img.src = img.dataset.src;
  }

  function attachOverlay(wrap, e) {
    wrap.appendChild(makeImg(e, true));
  }

  // Emotes already counted per chat message. Twitch splits a message into several text
  // spans around mentions and links, so this is kept per message, not per span.
  const countedIn = new WeakMap();

  // `counted` (a Set, or null to skip) collects the emotes added to this channel's usage stats.
  function replaceTextNode(node, counted) {
    const text = node.nodeValue;
    if (!text || !/\S/.test(text)) return false;
    const parts = text.split(/(\s+)/);
    if (!parts.some((p) => p && (state.map.has(p) || state.hiddenWords.has(p)))) return false;

    const frag = document.createDocumentFragment();
    let buf = '';
    let lastEmote = null; // last emote with only whitespace after it, for zero-width overlays

    for (const part of parts) {
      const e = part ? state.map.get(part) : undefined;
      if (!e) {
        const off = part ? state.hiddenWords.get(part) : undefined;
        if (off) {
          if (buf) { frag.appendChild(document.createTextNode(buf)); buf = ''; }
          frag.appendChild(makeHiddenWord(off));
          lastEmote = null;
          continue;
        }
        buf += part;
        if (/\S/.test(part)) lastEmote = null;
        continue;
      }
      if (counted && !counted.has(e.key)) { counted.add(e.key); countUsage(e.key); }
      if (e.zeroWidth && lastEmote) {
        attachOverlay(lastEmote, e);
        buf = ''; // the overlay takes the gap's place
        continue;
      }
      if (buf) { frag.appendChild(document.createTextNode(buf)); buf = ''; }
      lastEmote = makeEmote(e);
      frag.appendChild(lastEmote);
    }
    if (buf) frag.appendChild(document.createTextNode(buf));
    node.parentNode.replaceChild(frag, node);
    return true;
  }

  function processFragment(el, count = true) {
    if (!state.map.size || !el || !el.isConnected) return;
    const texts = [];
    for (const child of el.childNodes) {
      if (child.nodeType === 3) texts.push(child);
    }
    if (!texts.length) return;
    let counted = null;
    if (count) {
      const message = el.closest('.chat-line__message, .vod-message') || el;
      counted = countedIn.get(message);
      if (!counted) countedIn.set(message, counted = new Set());
    }
    for (const t of texts) replaceTextNode(t, counted);
  }

  function processTree(root) {
    if (root.nodeType !== 1) return;
    if (root.matches(FRAGMENT_SELECTOR)) processFragment(root);
    if (root.firstElementChild) for (const el of root.querySelectorAll(FRAGMENT_SELECTOR)) processFragment(el);
  }

  function rescan(count = true) {
    document.querySelectorAll(FRAGMENT_SELECTOR).forEach((el) => processFragment(el, count));
  }

  // After emotes are hidden or shown: turn chat emotes and hidden words that no longer
  // match back into text, then render the text again with the current maps.
  function refreshChat() {
    const touched = new Set();
    for (const node of document.querySelectorAll('.emotekit-emote, .emotekit-hidden-word')) {
      const fragment = node.parentElement;
      if (!fragment || !fragment.matches(FRAGMENT_SELECTOR)) continue; // picker or tooltip
      let text;
      if (node.classList.contains('emotekit-hidden-word')) {
        const e = state.hiddenWords.get(node.textContent);
        if (e && e.key === node.dataset.key) continue;
        text = node.textContent;
      } else {
        const imgs = [...node.querySelectorAll('img.emotekit-img')];
        if (imgs.every((img) => { const e = state.map.get(img.alt); return e && e.key === img.dataset.key; })) continue;
        text = imgs.map((img) => img.alt).join(' ');
      }
      node.replaceWith(document.createTextNode(text));
      touched.add(fragment);
    }
    for (const fragment of touched) fragment.normalize();
    rescan(false);
  }

  function onMutations(mutations) {
    if (!state.map.size) return;
    for (const m of mutations) {
      const t = m.target;
      // React can rewrite a span's text in place; re-check it.
      if (t.nodeType === 1 && t.matches(FRAGMENT_SELECTOR)) processFragment(t);
      else if (t.nodeType === 3 && t.parentElement && t.parentElement.matches(FRAGMENT_SELECTOR)) processFragment(t.parentElement);
      for (const n of m.addedNodes) processTree(n);
    }
  }

  function injectStyle() {
    const h = CONFIG.emoteHeight;
    const style = document.createElement('style');
    style.id = 'emotekit-style';
    style.textContent = `
      .emotekit-emote {
        display: inline-grid;
        vertical-align: middle;
        margin: -0.5rem 0;
      }
      .emotekit-emote > .emotekit-img {
        grid-area: 1 / 1;
        place-self: center;
        height: ${h}px;
        width: auto;
        max-width: none;
      }
      .emotekit-emote > .emotekit-overlay { pointer-events: none; }
      .emotekit-tooltip {
        position: fixed;
        z-index: 2147483647;
        display: none;
        pointer-events: none;
        max-width: 260px;
        padding: 6px 10px 7px;
        border-radius: 6px;
        background: #0e0e10;
        color: #efeff1;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
        font-family: inherit;
        font-size: 13px;
        line-height: 1.35;
        text-align: center;
        overflow-wrap: anywhere;
      }
      .emotekit-tooltip-preview { display: inline-grid; margin: 2px 0 4px; }
      .emotekit-tooltip-preview > img {
        grid-area: 1 / 1;
        place-self: center;
        height: ${h * 2}px;
        width: auto;
        max-width: 240px;
      }
      .emotekit-tooltip-name { font-weight: 600; }
      .emotekit-tooltip-hint { margin-top: 2px; color: #adadb8; font-size: 11px; }
      .emotekit-emote { cursor: pointer; }
      .emotekit-hidden-word { border-radius: 3px; cursor: pointer; }
      .emotekit-hidden-word:hover {
        background: var(--color-background-interactable-hover, rgba(83, 83, 95, 0.48));
        box-shadow: 0 0 0 2px var(--color-background-interactable-hover, rgba(83, 83, 95, 0.48));
        text-decoration: underline dotted;
      }
      .emotekit-menu {
        position: fixed;
        z-index: 2147483646;
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 6px;
        border: 1px solid var(--color-border-base, rgba(83, 83, 95, 0.48));
        border-radius: 6px;
        background: var(--color-background-float, #1f1f23);
        color: var(--color-text-base, #efeff1);
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
        font-size: 13px;
      }
      .emotekit-menu-row { display: flex; align-items: center; gap: 6px; }
      .emotekit-menu-name { flex: 1; margin-right: 4px; font-weight: 600; white-space: nowrap; }
      .emotekit-menu-service { margin-left: 6px; font-weight: 400; font-size: 12px; color: var(--color-text-alt-2, #adadb8); }
      .emotekit-menu-button {
        padding: 4px 8px;
        border: 0;
        border-radius: 4px;
        background: var(--color-background-button-secondary-default, rgba(83, 83, 95, 0.38));
        color: inherit;
        font: inherit;
        font-weight: 600;
        white-space: nowrap;
        cursor: pointer;
      }
      .emotekit-menu-button:hover { background: var(--color-background-button-secondary-hover, rgba(83, 83, 95, 0.55)); }
      .emotekit-menu-button[aria-pressed="true"] { color: #f5c400; }
      .emotekit-picker-button[aria-expanded="true"] {
        background: var(--color-background-button-text-active, rgba(83, 83, 95, 0.55));
      }
      .emotekit-picker {
        position: fixed;
        z-index: 2147483646; /* above Twitch overlays; it closes on any click outside */
        display: none;
        flex-direction: column;
        border: 1px solid var(--color-border-base, rgba(83, 83, 95, 0.48));
        border-radius: 6px;
        background: var(--color-background-float, #1f1f23);
        color: var(--color-text-base, #efeff1);
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
        font-size: 13px;
        overflow: hidden;
      }
      .emotekit-picker-bar { display: flex; gap: 6px; margin: 8px; }
      .emotekit-picker-search {
        flex: 1;
        min-width: 0;
        padding: 6px 10px;
        border: 1px solid var(--color-border-input, rgba(222, 222, 227, 0.4));
        border-radius: 4px;
        background: var(--color-background-input, #18181b);
        color: inherit;
        font: inherit;
        outline: none;
      }
      .emotekit-picker-search:focus { border-color: var(--color-text-link, #a970ff); }
      .emotekit-picker-hide-toggle {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 0 10px;
        border: 0;
        border-radius: 4px;
        background: var(--color-background-button-secondary-default, rgba(83, 83, 95, 0.38));
        color: inherit;
        font: inherit;
        font-weight: 600;
        white-space: nowrap;
        cursor: pointer;
      }
      .emotekit-picker-hide-toggle:hover { background: var(--color-background-button-secondary-hover, rgba(83, 83, 95, 0.55)); }
      .emotekit-picker-hide-toggle[aria-pressed="true"] {
        background: var(--color-background-button-primary-default, #9147ff);
        color: var(--color-text-button-primary, #fff);
      }
      .emotekit-picker-notice { margin: 0 8px 6px; font-size: 12px; color: var(--color-text-alt-2, #adadb8); }
      .emotekit-picker-notice[hidden] { display: none; }
      .emotekit-picker-hint { margin: 6px 2px 2px; font-size: 12px; color: var(--color-text-alt-2, #adadb8); }
      .emotekit-picker-manage {
        display: block;
        margin: 10px 2px 2px;
        padding: 0;
        border: 0;
        background: none;
        color: var(--color-text-link, #a970ff);
        font: inherit;
        font-size: 12px;
        cursor: pointer;
      }
      .emotekit-picker-manage:hover { text-decoration: underline; }
      .emotekit-picker-item { position: relative; }
      .emotekit-picker-item.emotekit-is-hidden .emotekit-emote,
      .emotekit-picker-item.emotekit-is-hidden .emotekit-picker-name { opacity: 0.3; filter: grayscale(1); }
      .emotekit-picker-item.emotekit-is-hidden::after {
        content: "";
        position: absolute;
        left: 6px;
        right: 6px;
        top: 50%;
        border-top: 2px solid var(--color-text-base, #efeff1);
        transform: rotate(-30deg);
      }
      .emotekit-hide-mode .emotekit-picker-item:not(.emotekit-is-hidden):hover .emotekit-emote { opacity: 0.6; }
      .emotekit-picker-list { overflow-y: auto; padding: 0 8px 8px; }
      .emotekit-picker-section > h3 {
        margin: 6px 2px 4px;
        font-size: 12px;
        font-weight: 600;
        color: var(--color-text-alt-2, #adadb8);
      }
      .emotekit-picker-grid { display: flex; flex-wrap: wrap; gap: 2px; }
      /* Let the browser skip layout for sections that are scrolled out of view. */
      .emotekit-picker-section { content-visibility: auto; contain-intrinsic-size: auto 240px; }
      .emotekit-picker-item {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 36px;
        height: 36px;
        padding: 2px 4px;
        border: 0;
        border-radius: 4px;
        background: transparent;
        cursor: pointer;
      }
      .emotekit-picker-item:hover { background: var(--color-background-interactable-hover, rgba(83, 83, 95, 0.48)); }
      .emotekit-picker-item.emotekit-loading { background: var(--color-background-alt-2, rgba(83, 83, 95, 0.3)); background-clip: content-box; }
      .emotekit-picker-item .emotekit-emote { margin: 0; }
      .emotekit-picker-item .emotekit-img { max-width: 112px; }
      .emotekit-picker-empty { margin: 12px 4px; color: var(--color-text-alt-2, #adadb8); }
      .emotekit-picker-name { font-size: 12px; color: var(--color-text-base, #efeff1); }
      .emotekit-tooltip-meta { color: #adadb8; font-size: 12px; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // ---------------------------------------------------------------------------
  // Tooltip: shown immediately on hover (a native title tooltip takes about a second in Safari)
  // ---------------------------------------------------------------------------

  // How long the tooltip stays up after the pointer leaves its emote, so it doesn't flicker
  // away in busy chat. Moving onto another emote still switches immediately.
  const TOOLTIP_HIDE_DELAY = 200; // ms

  const tooltip = { el: null, target: null, hideTimer: null };

  function showTooltip(wrap) {
    cancelHide();
    if (!tooltip.el || !tooltip.el.isConnected) {
      tooltip.el = document.createElement('div');
      tooltip.el.className = 'emotekit-tooltip';
      tooltip.el.setAttribute('role', 'tooltip');
      document.body.appendChild(tooltip.el);
    }
    const el = tooltip.el;
    tooltip.target = wrap;
    const line = (cls, text) => {
      const d = document.createElement('div');
      d.className = cls;
      d.textContent = text;
      return d;
    };
    if (wrap.classList.contains('emotekit-hidden-word')) {
      const e = state.all.get(wrap.dataset.key);
      el.replaceChildren(
        line('emotekit-tooltip-name', wrap.textContent),
        line('emotekit-tooltip-meta', `${e ? `${e.provider} · ` : ''}Hidden. Click to show it again.`),
      );
      el.style.display = 'block';
      positionTooltip();
      return;
    }
    const imgs = [...wrap.querySelectorAll('img.emotekit-img')];

    const preview = document.createElement('div');
    preview.className = 'emotekit-tooltip-preview';
    for (const img of imgs) {
      const big = document.createElement('img');
      big.src = img.dataset.large || img.src;
      big.alt = '';
      preview.appendChild(big);
    }
    const [base, ...overlays] = imgs;
    const inChat = !!wrap.parentElement && wrap.parentElement.matches(FRAGMENT_SELECTOR);
    el.replaceChildren(
      preview,
      line('emotekit-tooltip-name', wrap.dataset.emotekit),
      line('emotekit-tooltip-meta', `${base.dataset.provider} · ${base.dataset.source} emote`),
      ...overlays.map((o) => line('emotekit-tooltip-meta', `+ ${o.alt} · ${o.dataset.provider} ${o.dataset.source}`)),
      ...(hidden.has(base.dataset.key) ? [line('emotekit-tooltip-meta', 'Hidden in chat')] : []),
      ...(isFavourite(base.dataset.key) ? [line('emotekit-tooltip-meta', '★ Favourite')] : []),
      ...(inChat ? [line('emotekit-tooltip-hint', 'Click to favourite or hide')] : []),
    );

    el.style.display = 'block';
    positionTooltip();
  }

  function positionTooltip() {
    const el = tooltip.el;
    const r = tooltip.target.getBoundingClientRect();
    const t = el.getBoundingClientRect();
    const left = Math.max(4, Math.min(r.left + r.width / 2 - t.width / 2, window.innerWidth - t.width - 4));
    const top = r.top - t.height - 6 >= 4 ? r.top - t.height - 6 : r.bottom + 6;
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  function scheduleHide() {
    if (!tooltip.hideTimer) tooltip.hideTimer = setTimeout(hideTooltip, TOOLTIP_HIDE_DELAY);
  }

  function cancelHide() {
    clearTimeout(tooltip.hideTimer);
    tooltip.hideTimer = null;
  }

  function hideTooltip() {
    cancelHide();
    tooltip.target = null;
    if (tooltip.el) tooltip.el.style.display = 'none';
  }

  function onMouseOver(ev) {
    let wrap = ev.target && ev.target.closest ? ev.target.closest('.emotekit-emote, .emotekit-hidden-word') : null;
    if (wrap && wrap === emoteMenu.target) wrap = null; // its menu is open
    if (wrap) {
      if (wrap !== tooltip.target) showTooltip(wrap);
      else cancelHide(); // came back before it hid
    } else if (tooltip.target) {
      scheduleHide();
    }
  }

  // Busy chat scrolls several times a second. Keep the tooltip on its emote, and start the
  // hide delay once the emote has moved out from under the pointer or been removed.
  function onScroll() {
    const t = tooltip.target;
    if (!t) return;
    if (t.isConnected) positionTooltip();
    if (!t.isConnected || !t.matches(':hover')) scheduleHide();
  }

  function installTooltip() {
    document.addEventListener('mouseover', onMouseOver);
    document.addEventListener('mouseout', (ev) => { if (!ev.relatedTarget && tooltip.target) scheduleHide(); }); // pointer left the window
    document.addEventListener('scroll', onScroll, true);
  }

  // ---------------------------------------------------------------------------
  // Clicking an emote in chat opens a small menu to favourite or hide it. Clicking a
  // hidden emote's name shows the emote again.
  // ---------------------------------------------------------------------------

  const emoteMenu = { el: null, target: null };

  function openEmoteMenu(wrap) {
    closeEmoteMenu();
    hideTooltip();
    const el = document.createElement('div');
    el.className = 'emotekit-menu';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Emote options');
    for (const img of wrap.querySelectorAll('img.emotekit-img')) {
      const e = state.all.get(img.dataset.key);
      if (!e) continue;
      const row = document.createElement('div');
      row.className = 'emotekit-menu-row';
      const name = document.createElement('span');
      name.className = 'emotekit-menu-name';
      name.textContent = e.code;
      const service = document.createElement('span');
      service.className = 'emotekit-menu-service';
      service.textContent = e.provider;
      name.appendChild(service);
      const star = document.createElement('button');
      star.type = 'button';
      star.className = 'emotekit-menu-button';
      const syncStar = () => {
        const on = isFavourite(e.key);
        star.textContent = on ? '★ Favourite' : '☆ Favourite';
        star.setAttribute('aria-pressed', String(on));
      };
      syncStar();
      star.addEventListener('click', () => { setFavourite(e.key, !isFavourite(e.key)); syncStar(); });
      const hide = document.createElement('button');
      hide.type = 'button';
      hide.className = 'emotekit-menu-button';
      hide.textContent = 'Hide';
      hide.addEventListener('click', () => { closeEmoteMenu(); setHidden(e.key, true); });
      row.append(name, star, hide);
      el.appendChild(row);
    }
    if (!el.childElementCount) return;
    document.body.appendChild(el);
    emoteMenu.el = el;
    emoteMenu.target = wrap;
    positionEmoteMenu();
  }

  function positionEmoteMenu() {
    const r = emoteMenu.target.getBoundingClientRect();
    const t = emoteMenu.el.getBoundingClientRect();
    const left = Math.max(4, Math.min(r.left + r.width / 2 - t.width / 2, window.innerWidth - t.width - 4));
    const top = r.top - t.height - 6 >= 4 ? r.top - t.height - 6 : r.bottom + 6;
    emoteMenu.el.style.left = `${Math.round(left)}px`;
    emoteMenu.el.style.top = `${Math.round(top)}px`;
  }

  function closeEmoteMenu() {
    if (emoteMenu.el) emoteMenu.el.remove();
    emoteMenu.el = null;
    emoteMenu.target = null;
  }

  function onChatClick(ev) {
    if (ev.button !== 0 || !ev.target.closest) return;
    const node = ev.target.closest('.emotekit-emote, .emotekit-hidden-word');
    if (!node || !node.parentElement || !node.parentElement.matches(FRAGMENT_SELECTOR)) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (node.classList.contains('emotekit-hidden-word')) {
      hideTooltip();
      setHidden(node.dataset.key, false);
    } else if (emoteMenu.target === node) {
      closeEmoteMenu();
    } else {
      openEmoteMenu(node);
    }
  }

  function installEmoteMenu() {
    document.addEventListener('click', onChatClick, true); // before Twitch's own handlers
    document.addEventListener('mousedown', (ev) => {
      if (!emoteMenu.el) return;
      if (emoteMenu.el.contains(ev.target) || emoteMenu.target.contains(ev.target)) return;
      closeEmoteMenu();
    }, true);
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeEmoteMenu(); });
    // Follow the emote while chat scrolls; close once it's gone.
    document.addEventListener('scroll', () => {
      if (!emoteMenu.el) return;
      if (emoteMenu.target.isConnected) positionEmoteMenu();
      else closeEmoteMenu();
    }, true);
    window.addEventListener('resize', closeEmoteMenu);
  }

  // ---------------------------------------------------------------------------
  // Chat input
  // Twitch's chat box is a Slate editor. It ignores direct DOM edits, but it handles
  // beforeinput events the same way as typing, so text is changed by sending those.
  // ---------------------------------------------------------------------------

  const CHAT_INPUT_SELECTOR = '[data-a-target="chat-input"]';

  function sendInput(el, inputType, data = null) {
    return !el.dispatchEvent(new InputEvent('beforeinput', {
      inputType, data, bubbles: true, cancelable: true, composed: true,
    }));
  }

  // Each deleteContentBackward removes one user-perceived character.
  function charCount(text) {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) return [...new Intl.Segmenter().segment(text)].length;
    return Array.from(text).length;
  }

  // Replaces the last `removed` text before the caret with `text`.
  function replaceBeforeCaret(el, removed, text) {
    for (let i = charCount(removed); i > 0; i--) sendInput(el, 'deleteContentBackward');
    if (text) sendInput(el, 'insertText', text);
  }

  // Text between the start of the caret's text node and the caret, or null if the caret
  // isn't a plain caret inside `el`. Slate pads empty lines with a zero-width character.
  function textBeforeCaret(el) {
    const sel = window.getSelection();
    if (!sel || !sel.isCollapsed || !sel.anchorNode || !el.contains(sel.anchorNode)) return null;
    const node = sel.anchorNode;
    if (node.nodeType !== 3) return '';
    return node.nodeValue.slice(0, sel.anchorOffset).replace(/﻿/g, '');
  }

  // Puts the caret at the end of the editor's text if it isn't already inside it.
  function ensureCaret(el) {
    const sel = window.getSelection();
    if (document.activeElement === el && sel.anchorNode && el.contains(sel.anchorNode)) return false;
    el.focus();
    const leaves = el.querySelectorAll('[data-slate-string], [data-slate-zero-width]');
    const last = leaves[leaves.length - 1];
    const node = last && last.firstChild;
    if (!node) return true;
    const range = document.createRange();
    range.setStart(node, last.hasAttribute('data-slate-zero-width') ? 0 : node.nodeValue.length);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  }

  // Inserts an emote name at the caret, with a space before it if needed and one after it.
  async function insertIntoChat(code) {
    const el = document.querySelector(CHAT_INPUT_SELECTOR);
    if (!el) return false;
    // Slate picks up a moved caret on its next selectionchange, so give it a moment.
    if (ensureCaret(el)) await new Promise((r) => setTimeout(r, 150));
    const before = textBeforeCaret(el) || '';
    const lead = before && !/\s$/.test(before) ? ' ' : '';
    return sendInput(el, 'insertText', `${lead}${code} `);
  }

  // ---------------------------------------------------------------------------
  // Tab completion: type the start of an emote name and press Tab. Tab again cycles
  // forward through the matches, Shift+Tab backward.
  // ---------------------------------------------------------------------------

  const completion = { matches: null, index: 0, inserted: '' };

  // Favourites first, then the most used in this channel. Ties: exact-case matches, then
  // shorter names.
  function findCompletions(prefix) {
    const lower = prefix.toLowerCase();
    const matches = [];
    for (const [code, e] of state.map) {
      if (code.toLowerCase().startsWith(lower)) matches.push(e);
    }
    const exact = (e) => (e.code.startsWith(prefix) ? 0 : 1);
    matches.sort((a, b) => fav(a) - fav(b) || score(b) - score(a) || exact(a) - exact(b) || a.code.length - b.code.length || a.code.localeCompare(b.code));
    return matches.map((e) => e.code);
  }

  function endCompletion() {
    completion.matches = null;
  }

  function onChatKeyDown(ev) {
    if (ev.key !== 'Tab') {
      if (ev.key !== 'Shift') endCompletion();
      return;
    }
    if (ev.altKey || ev.ctrlKey || ev.metaKey || ev.isComposing) return;
    const el = ev.target && ev.target.closest ? ev.target.closest(CHAT_INPUT_SELECTOR) : null;
    if (!el) return;
    const before = textBeforeCaret(el);
    if (before === null) return;

    let removed;
    if (completion.matches && before.endsWith(completion.inserted)) {
      const n = completion.matches.length;
      completion.index = (completion.index + (ev.shiftKey ? n - 1 : 1)) % n;
      removed = completion.inserted;
    } else {
      endCompletion();
      const prefix = before.match(/\S*$/)[0];
      // @mentions and :emote search belong to Twitch's own autocomplete.
      if (!prefix || /^[@:]/.test(prefix)) return;
      const matches = findCompletions(prefix);
      if (!matches.length) { completion.matches = null; return; }
      completion.matches = matches;
      completion.index = ev.shiftKey ? matches.length - 1 : 0;
      removed = prefix;
    }
    // Without this, Tab moves focus out of the chat box.
    ev.preventDefault();
    ev.stopImmediatePropagation();
    const text = `${completion.matches[completion.index]} `;
    replaceBeforeCaret(el, removed, text);
    completion.inserted = text;
  }

  function installCompletion() {
    window.addEventListener('keydown', onChatKeyDown, true); // before Twitch's own handlers
  }

  // ---------------------------------------------------------------------------
  // Emote picker: a button next to Twitch's emote button opens the channel's emotes.
  // It opens on what you're likely to want (your favourites, then what this channel's
  // chat uses most), then every emote by service. "Hide emotes" mode turns emotes off.
  // ---------------------------------------------------------------------------

  const picker = {
    button: null, panel: null, search: null, list: null, hideToggle: null, notice: null,
    hideMode: false, loadQueued: false,
    groups: { key: null, nodes: [] }, // service sections, reused until the emotes change
  };

  const PICKER_GROUPS = [
    ['Channel', '7TV'], ['Channel', 'BTTV'], ['Channel', 'FFZ'],
    ['Global', '7TV'], ['Global', 'BTTV'], ['Global', 'FFZ'],
  ];
  const POPULAR_SHOWN = 100;
  const RESULTS_SHOWN = 300;

  // Four-square grid: distinct from Twitch's smiley. Drawn in Twitch's 24px icon box.
  const PICKER_ICON = '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
    + '<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/>'
    + '<rect x="3" y="13" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/></svg>';

  // Crossed-out eye.
  const HIDE_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">'
    + '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M4 20 20 4"/></svg>';

  // The button is a copy of Twitch's own emote button with the icon swapped, so it lines up
  // and behaves like the buttons next to it in every browser.
  function ensurePickerButton() {
    if (picker.button && picker.button.isConnected) return;
    const twitchButton = document.querySelector('[data-a-target="emote-picker-button"]');
    const slot = twitchButton && twitchButton.parentElement;
    if (!slot || !slot.parentElement) return;
    const wrap = slot.cloneNode(false);
    wrap.classList.add('emotekit-picker-slot');
    const button = twitchButton.cloneNode(true);
    for (const a of [...button.attributes]) if (a.name.startsWith('data-')) button.removeAttribute(a.name);
    button.type = 'button';
    button.classList.add('emotekit-picker-button');
    button.setAttribute('aria-label', 'EmoteKit emotes');
    button.setAttribute('aria-expanded', 'false');
    const svg = button.querySelector('svg');
    if (svg) svg.outerHTML = PICKER_ICON;
    else button.innerHTML = PICKER_ICON;
    button.addEventListener('click', () => (pickerIsOpen() ? closePicker() : openPicker()));
    wrap.appendChild(button);
    slot.parentElement.insertBefore(wrap, slot);
    picker.button = button;
  }

  function pickerIsOpen() {
    return !!picker.panel && picker.panel.style.display === 'flex';
  }

  function buildPickerPanel() {
    const panel = document.createElement('div');
    panel.className = 'emotekit-picker';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'EmoteKit emotes');

    const bar = document.createElement('div');
    bar.className = 'emotekit-picker-bar';
    const search = document.createElement('input');
    search.type = 'text';
    search.className = 'emotekit-picker-search';
    search.placeholder = 'Search emotes';
    search.setAttribute('aria-label', 'Search emotes');
    search.autocomplete = 'off';
    search.spellcheck = false;
    search.addEventListener('input', () => renderPicker());
    search.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        closePicker();
      }
    });
    // Insert on keyup, not keydown: inserting moves focus to the chat box, and the rest of
    // the Enter keypress would then land there and send the message.
    search.addEventListener('keyup', (ev) => {
      if (ev.key !== 'Enter' || ev.isComposing || picker.hideMode) return;
      const first = picker.list.querySelector('.emotekit-picker-item');
      if (first) onItemClick(first);
    });

    const hideToggle = document.createElement('button');
    hideToggle.type = 'button';
    hideToggle.className = 'emotekit-picker-hide-toggle';
    hideToggle.setAttribute('aria-pressed', 'false');
    hideToggle.addEventListener('click', () => setHideMode(!picker.hideMode));
    bar.append(search, hideToggle);

    const notice = document.createElement('p');
    notice.className = 'emotekit-picker-notice';
    notice.textContent = 'Click an emote to hide it in chat. Click a hidden one to show it again.';

    const list = document.createElement('div');
    list.className = 'emotekit-picker-list';
    list.addEventListener('scroll', queuePickerLoad, { passive: true });
    // Keep focus (and the caret) in the chat box when clicking an emote.
    list.addEventListener('mousedown', (ev) => { if (ev.target.closest('button')) ev.preventDefault(); });
    list.addEventListener('click', (ev) => {
      const item = ev.target.closest('.emotekit-picker-item');
      if (item) onItemClick(item);
      else if (ev.target.closest('.emotekit-picker-manage')) setHideMode(true);
    });

    panel.append(bar, notice, list);
    document.body.appendChild(panel);
    Object.assign(picker, { panel, search, list, hideToggle, notice });
    setHideMode(false, false);
  }

  function onItemClick(item) {
    const e = state.all.get(item.dataset.key);
    if (!e) return;
    if (picker.hideMode) {
      setHidden(e.key, !hidden.has(e.key));
      return;
    }
    insertIntoChat(e.code);
  }

  function setHideMode(on, render = true) {
    picker.hideMode = on;
    picker.panel.classList.toggle('emotekit-hide-mode', on);
    picker.hideToggle.setAttribute('aria-pressed', String(on));
    picker.hideToggle.innerHTML = on ? 'Done' : `${HIDE_ICON}<span>Hide emotes</span>`;
    picker.notice.hidden = !on;
    if (render) renderPicker();
  }

  function makePickerItem(e) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'emotekit-picker-item emotekit-loading'; // grey placeholder until the image arrives
    if (hidden.has(e.key)) item.classList.add('emotekit-is-hidden');
    item.dataset.key = e.key;
    item.dataset.code = e.code;
    item.setAttribute('aria-label', e.code);
    const emote = makeEmote(e, true);
    const img = emote.querySelector('img');
    img.alt = ''; // the button carries the name
    img.addEventListener('load', () => item.classList.remove('emotekit-loading'), { once: true });
    // If the image fails, show the name instead of a broken-image icon.
    img.addEventListener('error', () => {
      item.classList.remove('emotekit-loading');
      emote.replaceWith(Object.assign(document.createElement('span'), { className: 'emotekit-picker-name', textContent: e.code }));
    }, { once: true });
    item.appendChild(emote);
    return item;
  }

  function pickerSection(title, emotes, count = emotes.length) {
    const section = document.createElement('section');
    section.className = 'emotekit-picker-section';
    const h = document.createElement('h3');
    h.textContent = `${title} (${count})`;
    const grid = document.createElement('div');
    grid.className = 'emotekit-picker-grid';
    for (const e of emotes) grid.appendChild(makePickerItem(e));
    section.append(h, grid);
    return section;
  }

  function pickerNote(text, className = 'emotekit-picker-empty') {
    return Object.assign(document.createElement('p'), { className, textContent: text });
  }

  const byName = (a, b) => a.code.localeCompare(b.code, undefined, { sensitivity: 'base' });

  // The emotes the picker offers: those shown in chat, plus hidden ones in hide mode.
  function pickerEmotes() {
    return [...(picker.hideMode ? state.full : state.map).values()];
  }

  function renderPicker({ keepScroll = false } = {}) {
    const scrollTop = picker.list.scrollTop;
    const query = picker.search.value.trim().toLowerCase();
    const emotes = pickerEmotes();
    const parts = [];

    if (!state.full.size) {
      parts.push(pickerNote('Emotes are still loading.'));
    } else if (query) {
      const results = emotes.filter((e) => e.code.toLowerCase().includes(query));
      const starts = (e) => (e.code.toLowerCase().startsWith(query) ? 0 : 1);
      results.sort((a, b) => starts(a) - starts(b) || fav(a) - fav(b) || score(b) - score(a) || a.code.length - b.code.length || byName(a, b));
      if (results.length) parts.push(pickerSection('Results', results.slice(0, RESULTS_SHOWN), results.length));
      else parts.push(pickerNote('No emotes match.'));
    } else {
      if (picker.hideMode) {
        const off = emotes.filter((e) => hidden.has(e.key)).sort(byName);
        parts.push(off.length ? pickerSection('Hidden', off) : pickerNote('No hidden emotes in this channel yet.'));
      } else {
        const starred = favourites.map((k) => state.all.get(k)).filter((e) => e && state.map.get(e.code) === e);
        parts.push(starred.length ? pickerSection('Favourites', starred)
          : pickerNote('Click an emote in chat to add it to your favourites.', 'emotekit-picker-hint'));
      }
      const popular = emotes.filter((e) => score(e) >= 0.5).sort((a, b) => score(b) - score(a) || byName(a, b)).slice(0, POPULAR_SHOWN);
      if (popular.length) parts.push(pickerSection('Popular here', popular));
      else if (!picker.hideMode) parts.push(pickerNote('Popular emotes show up here once some chat has come in.', 'emotekit-picker-hint'));
      parts.push(...groupSections(emotes));
      if (!picker.hideMode) {
        const n = state.hiddenWords.size;
        if (n) {
          const manage = document.createElement('button');
          manage.type = 'button';
          manage.className = 'emotekit-picker-manage';
          manage.textContent = `${n} hidden emote${n === 1 ? '' : 's'} · Manage`;
          parts.push(manage);
        }
      }
    }
    picker.list.replaceChildren(...parts);
    picker.list.scrollTop = keepScroll ? scrollTop : 0;
    loadVisiblePickerImages();
  }

  // Every emote by service. These are most of the picker (1000+ buttons on big channels), so
  // they're built once per emote list and mode, and reused on reopen and after a search.
  function groupSections(emotes) {
    const key = `${state.mapVersion}:${picker.hideMode}`;
    if (picker.groups.key === key) return picker.groups.nodes;
    const groups = new Map(PICKER_GROUPS.map(([source, provider]) => [`${source} · ${provider}`, []]));
    for (const e of emotes) {
      const g = groups.get(`${e.source} · ${e.provider}`);
      if (g) g.push(e);
    }
    const nodes = [];
    for (const [title, list] of groups) if (list.length) nodes.push(pickerSection(title, list.sort(byName)));
    picker.groups = { key, nodes };
    return nodes;
  }

  // In hide mode, toggling an emote just dims or undims it in place, so nothing jumps.
  function syncHiddenItems() {
    for (const item of picker.list.querySelectorAll('.emotekit-picker-item')) {
      item.classList.toggle('emotekit-is-hidden', hidden.has(item.dataset.key));
    }
  }

  // Big channels have 1000+ emotes, many of them large animations. Load only what is on
  // screen or about to scroll in, so the visible ones aren't stuck behind the rest.
  function loadVisiblePickerImages() {
    if (!pickerIsOpen()) return;
    const r = picker.list.getBoundingClientRect();
    const margin = 150;
    const near = (b) => b.bottom >= r.top - margin && b.top <= r.bottom + margin;
    // Check whole sections first; off-screen ones are skipped without measuring their emotes.
    for (const section of picker.list.querySelectorAll('.emotekit-picker-section')) {
      if (!near(section.getBoundingClientRect())) continue;
      for (const item of section.querySelectorAll('.emotekit-picker-item.emotekit-loading')) {
        if (!near(item.getBoundingClientRect())) continue;
        const img = item.querySelector('img');
        if (img && !img.getAttribute('src')) loadImage(img);
      }
    }
  }

  function queuePickerLoad() {
    if (picker.loadQueued) return;
    picker.loadQueued = true;
    setTimeout(() => { picker.loadQueued = false; loadVisiblePickerImages(); }, 50); // at most every 50 ms while scrolling
  }

  function positionPicker() {
    const anchor = picker.button.closest('.chat-input__textarea') || picker.button;
    const r = anchor.getBoundingClientRect();
    const width = Math.min(340, window.innerWidth - 16);
    const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
    picker.panel.style.width = `${width}px`;
    picker.panel.style.left = `${Math.round(left)}px`;
    picker.panel.style.bottom = `${Math.round(window.innerHeight - r.top + 6)}px`;
    picker.panel.style.maxHeight = `${Math.max(200, Math.min(460, r.top - 16))}px`;
  }

  function openPicker() {
    if (!picker.button) return;
    if (!picker.panel || !picker.panel.isConnected) buildPickerPanel();
    picker.search.value = '';
    picker.panel.style.display = 'flex';
    positionPicker();
    setHideMode(false); // renders with current stats
    picker.button.setAttribute('aria-expanded', 'true');
    picker.search.focus();
  }

  function closePicker() {
    if (!pickerIsOpen()) return;
    picker.panel.style.display = 'none';
    if (picker.button) picker.button.setAttribute('aria-expanded', 'false');
    hideTooltip();
  }

  function installPicker() {
    ensurePickerButton();
    // Close on a click outside the picker and its button, or on Escape anywhere.
    document.addEventListener('mousedown', (ev) => {
      if (!pickerIsOpen()) return;
      if (picker.panel.contains(ev.target) || (picker.button && picker.button.contains(ev.target))) return;
      closePicker();
    }, true);
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closePicker(); });
    window.addEventListener('resize', closePicker);
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  const api = {
    parseBttv, parseBttvChannel, parseFfzGlobal, parseFfzRoom, parse7tvGlobal, parse7tvUser,
    buildMap, channelFromPath, processFragment, processTree, onMutations, rescan, state,
    installTooltip, tooltip,
    installCompletion, findCompletions, completion, insertIntoChat,
    installPicker, ensurePickerButton, openPicker, closePicker, renderPicker, picker,
    setHidden, hidden, refreshChat, applyEmoteLists, loadUsage, saveUsage, countUsage, usage, score,
    setFavourite, isFavourite, getFavourites: () => favourites,
    installEmoteMenu, emoteMenu, closeEmoteMenu, installStorageSync,
  };

  // Test hook: tests set this object before loading the script.
  if (typeof globalThis.__EMOTEKIT_TEST__ === 'object' && globalThis.__EMOTEKIT_TEST__) {
    Object.assign(globalThis.__EMOTEKIT_TEST__, api);
    return;
  }

  function start() {
    if (document.getElementById('emotekit-style')) return; // already running
    injectStyle();
    installTooltip();
    installCompletion();
    installPicker();
    installEmoteMenu();
    installStorageSync();
    new MutationObserver(onMutations).observe(document.documentElement, {
      childList: true, subtree: true, characterData: true,
    });
    handleRoute();
    // Twitch is a single-page app; poll the URL to catch channel switches.
    setInterval(() => { handleRoute(); ensurePickerButton(); }, 1000); // Twitch re-renders the chat box at times
    window.addEventListener('popstate', handleRoute);
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
