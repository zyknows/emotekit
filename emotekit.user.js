// ==UserScript==
// @name         EmoteKit for Twitch
// @namespace    https://github.com/zyknows/emotekit
// @version      0.1.2
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
  // Emote shape: { code, provider, source, url1x, url2x, zeroWidth }
  // ---------------------------------------------------------------------------

  function parseBttv(list, source) {
    if (!Array.isArray(list)) return [];
    return list
      // modifier: true marks BTTV text modifiers (w!, h!, z!...), which change the next emote rather than render.
      .filter((e) => e && e.id && e.code && e.modifier !== true)
      .map((e) => ({
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
      out.push({ code: e.name, provider: '7TV', source, url1x, url2x: pick('2x'), zeroWidth });
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
    map: new Map(),
    globals: null,
    globalsPromise: null,
    channelCache: new Map(), // twitch user id -> emote list
    routeKey: undefined,
    routeToken: 0,
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
    if (target) {
      try {
        const ch = await resolveChannel(target);
        if (ch) {
          label = ch.login;
          channel = await loadChannel(ch.id);
        } else {
          warn(`Could not find a Twitch user for ${key}`);
        }
      } catch (err) {
        warn('Channel emotes failed:', err && err.message);
      }
    }
    if (token !== state.routeToken) return; // user navigated away meanwhile

    state.map = buildMap([globals, channel]);
    console.info(TAG, `${state.map.size} emotes ready (${channel.length} from ${label})`);
    rescan();
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  // Live chat, popout chat and VOD chat replay all put plain message text in these spans.
  const FRAGMENT_SELECTOR = '[data-a-target="chat-message-text"], .text-fragment';

  function makeEmote(e) {
    const wrap = document.createElement('span');
    wrap.className = 'emotekit-emote';
    wrap.dataset.emotekit = e.code;
    wrap.appendChild(makeImg(e, false));
    return wrap;
  }

  function makeImg(e, overlay) {
    const img = document.createElement('img');
    img.className = overlay ? 'emotekit-img emotekit-overlay' : 'emotekit-img';
    img.src = e.url1x;
    if (e.url2x) img.srcset = `${e.url1x} 1x, ${e.url2x} 2x`;
    img.alt = e.code; // copying chat text keeps the emote name
    img.decoding = 'async';
    img.dataset.provider = e.provider; // read by the tooltip
    img.dataset.source = e.source;
    img.dataset.large = e.url2x || e.url1x;
    return img;
  }

  function attachOverlay(wrap, e) {
    wrap.appendChild(makeImg(e, true));
  }

  function replaceTextNode(node) {
    const text = node.nodeValue;
    if (!text || !/\S/.test(text)) return false;
    const parts = text.split(/(\s+)/);
    if (!parts.some((p) => p && state.map.has(p))) return false;

    const frag = document.createDocumentFragment();
    let buf = '';
    let lastEmote = null; // last emote with only whitespace after it, for zero-width overlays

    for (const part of parts) {
      const e = part ? state.map.get(part) : undefined;
      if (!e) {
        buf += part;
        if (/\S/.test(part)) lastEmote = null;
        continue;
      }
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

  function processFragment(el) {
    if (!state.map.size || !el || !el.isConnected) return;
    const texts = [];
    for (const child of el.childNodes) {
      if (child.nodeType === 3) texts.push(child);
    }
    for (const t of texts) replaceTextNode(t);
  }

  function processTree(root) {
    if (root.nodeType !== 1) return;
    if (root.matches(FRAGMENT_SELECTOR)) processFragment(root);
    if (root.firstElementChild) root.querySelectorAll(FRAGMENT_SELECTOR).forEach(processFragment);
  }

  function rescan() {
    document.querySelectorAll(FRAGMENT_SELECTOR).forEach(processFragment);
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
        z-index: 10000;
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
      .emotekit-tooltip-meta { color: #adadb8; font-size: 12px; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // ---------------------------------------------------------------------------
  // Tooltip: shown immediately on hover (a native title tooltip takes about a second in Safari)
  // ---------------------------------------------------------------------------

  const tooltip = { el: null, target: null };

  function showTooltip(wrap) {
    if (!tooltip.el || !tooltip.el.isConnected) {
      tooltip.el = document.createElement('div');
      tooltip.el.className = 'emotekit-tooltip';
      tooltip.el.setAttribute('role', 'tooltip');
      document.body.appendChild(tooltip.el);
    }
    const el = tooltip.el;
    tooltip.target = wrap;
    const imgs = [...wrap.querySelectorAll('img.emotekit-img')];

    const preview = document.createElement('div');
    preview.className = 'emotekit-tooltip-preview';
    for (const img of imgs) {
      const big = document.createElement('img');
      big.src = img.dataset.large || img.src;
      big.alt = '';
      preview.appendChild(big);
    }
    const line = (cls, text) => {
      const d = document.createElement('div');
      d.className = cls;
      d.textContent = text;
      return d;
    };
    const [base, ...overlays] = imgs;
    el.replaceChildren(
      preview,
      line('emotekit-tooltip-name', base.alt),
      line('emotekit-tooltip-meta', `${base.dataset.provider} · ${base.dataset.source} emote`),
      ...overlays.map((o) => line('emotekit-tooltip-meta', `+ ${o.alt} · ${o.dataset.provider} ${o.dataset.source}`)),
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

  function hideTooltip() {
    tooltip.target = null;
    if (tooltip.el) tooltip.el.style.display = 'none';
  }

  function onMouseOver(ev) {
    const wrap = ev.target && ev.target.closest ? ev.target.closest('.emotekit-emote') : null;
    if (wrap) { if (wrap !== tooltip.target) showTooltip(wrap); } else if (tooltip.target) hideTooltip();
  }

  // Busy chat scrolls several times a second. Keep the tooltip on its emote while the pointer
  // is still on it, and hide it once the emote has moved away or been removed.
  function onScroll() {
    const t = tooltip.target;
    if (!t) return;
    if (t.isConnected && t.matches(':hover')) positionTooltip();
    else hideTooltip();
  }

  function installTooltip() {
    document.addEventListener('mouseover', onMouseOver);
    document.addEventListener('mouseout', (ev) => { if (!ev.relatedTarget) hideTooltip(); }); // pointer left the window
    document.addEventListener('scroll', onScroll, true);
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  const api = {
    parseBttv, parseBttvChannel, parseFfzGlobal, parseFfzRoom, parse7tvGlobal, parse7tvUser,
    buildMap, channelFromPath, processFragment, processTree, onMutations, rescan, state,
    installTooltip, tooltip,
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
    new MutationObserver(onMutations).observe(document.documentElement, {
      childList: true, subtree: true, characterData: true,
    });
    handleRoute();
    // Twitch is a single-page app; poll the URL to catch channel switches.
    setInterval(handleRoute, 1000);
    window.addEventListener('popstate', handleRoute);
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
