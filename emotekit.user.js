// ==UserScript==
// @name         EmoteKit for Twitch
// @namespace    https://github.com/zyknows/emotekit
// @version      0.2.0
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
    state.mapVersion++;
    closePicker();
    console.info(TAG, `${state.map.size} emotes ready (${channel.length} from ${label})`);
    rescan();
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
    img.dataset.provider = e.provider; // read by the tooltip
    img.dataset.source = e.source;
    img.dataset.large = e.url2x || e.url1x;
    return img;
  }

  function loadImage(img) {
    if (img.dataset.srcset) img.srcset = img.dataset.srcset;
    img.src = img.dataset.src;
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
      .emotekit-picker-slot { display: inline-block; }
      .emotekit-picker-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        padding: 0;
        border: 0;
        border-radius: 4px;
        background: transparent;
        color: var(--color-fill-button-icon, #efeff1);
        fill: currentColor;
        cursor: pointer;
      }
      .emotekit-picker-button:hover,
      .emotekit-picker-button[aria-expanded="true"] {
        background: var(--color-background-button-text-hover, rgba(83, 83, 95, 0.48));
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
      .emotekit-picker-search {
        margin: 8px;
        padding: 6px 10px;
        border: 1px solid var(--color-border-input, rgba(222, 222, 227, 0.4));
        border-radius: 4px;
        background: var(--color-background-input, #18181b);
        color: inherit;
        font: inherit;
        outline: none;
      }
      .emotekit-picker-search:focus { border-color: var(--color-text-link, #a970ff); }
      .emotekit-picker-list { overflow-y: auto; padding: 0 8px 8px; }
      .emotekit-picker-section > h3 {
        margin: 6px 2px 4px;
        font-size: 12px;
        font-weight: 600;
        color: var(--color-text-alt-2, #adadb8);
      }
      .emotekit-picker-grid { display: flex; flex-wrap: wrap; gap: 2px; }
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
      .emotekit-picker-item[hidden], .emotekit-picker-section[hidden], .emotekit-picker-empty[hidden] { display: none; }
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
      line('emotekit-tooltip-name', wrap.dataset.emotekit),
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
    const wrap = ev.target && ev.target.closest ? ev.target.closest('.emotekit-emote') : null;
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

  // Exact-case prefix matches first, then case-insensitive ones; shorter names first.
  function findCompletions(prefix) {
    const lower = prefix.toLowerCase();
    const exact = [];
    const loose = [];
    for (const code of state.map.keys()) {
      if (code.startsWith(prefix)) exact.push(code);
      else if (code.toLowerCase().startsWith(lower)) loose.push(code);
    }
    const order = (a, b) => a.length - b.length || a.localeCompare(b);
    return [...exact.sort(order), ...loose.sort(order)];
  }

  function onChatKeyDown(ev) {
    if (ev.key !== 'Tab') {
      if (ev.key !== 'Shift') completion.matches = null;
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
  // Emote picker: a button next to Twitch's emote button opens a searchable list of
  // every emote in the channel. Clicking one adds it to the message.
  // ---------------------------------------------------------------------------

  const picker = { button: null, panel: null, search: null, list: null, version: -1, observer: null };

  const PICKER_GROUPS = [
    ['Channel', '7TV'], ['Channel', 'BTTV'], ['Channel', 'FFZ'],
    ['Global', '7TV'], ['Global', 'BTTV'], ['Global', 'FFZ'],
  ];

  function ensurePickerButton() {
    if (picker.button && picker.button.isConnected) return;
    const twitchButton = document.querySelector('[data-a-target="emote-picker-button"]');
    const slot = twitchButton && twitchButton.parentElement;
    if (!slot || !slot.parentElement) return;
    const wrap = document.createElement('div');
    wrap.className = 'emotekit-picker-slot';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'emotekit-picker-button';
    button.setAttribute('aria-label', 'EmoteKit emotes');
    button.setAttribute('aria-expanded', 'false');
    // Four-square grid: distinct from Twitch's smiley.
    button.innerHTML = '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">'
      + '<rect x="2" y="2" width="7" height="7" rx="2"/><rect x="11" y="2" width="7" height="7" rx="2"/>'
      + '<rect x="2" y="11" width="7" height="7" rx="2"/><rect x="11" y="11" width="7" height="7" rx="2"/></svg>';
    button.addEventListener('click', () => (picker.panel && picker.panel.style.display === 'flex' ? closePicker() : openPicker()));
    wrap.appendChild(button);
    slot.parentElement.insertBefore(wrap, slot);
    picker.button = button;
  }

  function buildPickerPanel() {
    const panel = document.createElement('div');
    panel.className = 'emotekit-picker';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'EmoteKit emotes');

    const search = document.createElement('input');
    search.type = 'text';
    search.className = 'emotekit-picker-search';
    search.placeholder = 'Search emotes';
    search.setAttribute('aria-label', 'Search emotes');
    search.autocomplete = 'off';
    search.spellcheck = false;
    search.addEventListener('input', () => filterPicker(search.value));
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
      if (ev.key !== 'Enter' || ev.isComposing) return;
      const first = [...picker.list.querySelectorAll('.emotekit-picker-item')].find((b) => !b.hidden);
      if (first) insertIntoChat(first.dataset.code);
    });

    const list = document.createElement('div');
    list.className = 'emotekit-picker-list';
    // Keep focus (and the caret) in the chat box when clicking an emote.
    list.addEventListener('mousedown', (ev) => { if (ev.target.closest('.emotekit-picker-item')) ev.preventDefault(); });
    list.addEventListener('click', (ev) => {
      const item = ev.target.closest('.emotekit-picker-item');
      if (item) insertIntoChat(item.dataset.code);
    });

    panel.append(search, list);
    document.body.appendChild(panel);
    picker.panel = panel;
    picker.search = search;
    picker.list = list;
  }

  function fillPicker() {
    const groups = new Map(PICKER_GROUPS.map(([source, provider]) => [`${source} · ${provider}`, []]));
    for (const e of state.map.values()) {
      const g = groups.get(`${e.source} · ${e.provider}`);
      if (g) g.push(e);
    }
    const sections = [];
    for (const [title, emotes] of groups) {
      if (!emotes.length) continue;
      emotes.sort((a, b) => a.code.localeCompare(b.code, undefined, { sensitivity: 'base' }));
      const section = document.createElement('section');
      section.className = 'emotekit-picker-section';
      const h = document.createElement('h3');
      h.dataset.title = title;
      h.textContent = `${title} (${emotes.length})`;
      const grid = document.createElement('div');
      grid.className = 'emotekit-picker-grid';
      for (const e of emotes) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'emotekit-picker-item';
        item.dataset.code = e.code;
        item.setAttribute('aria-label', e.code);
        const emote = makeEmote(e, true);
        const img = emote.querySelector('img');
        img.alt = ''; // the button carries the name
        // If the image fails, show the name instead of a broken-image icon.
        img.addEventListener('error', () => {
          emote.replaceWith(Object.assign(document.createElement('span'), { className: 'emotekit-picker-name', textContent: e.code }));
        }, { once: true });
        item.appendChild(emote);
        grid.appendChild(item);
      }
      section.append(h, grid);
      sections.push(section);
    }
    const empty = document.createElement('p');
    empty.className = 'emotekit-picker-empty';
    empty.textContent = state.map.size ? 'No emotes match.' : 'Emotes are still loading.';
    empty.hidden = sections.length > 0;
    picker.list.replaceChildren(...sections, empty);
    picker.version = state.mapVersion;
    observePickerImages();
  }

  // Big channels have 1000+ emotes, many of them large animations. Load only what is on
  // screen or about to scroll in, so the visible ones aren't stuck behind the rest.
  function observePickerImages() {
    const imgs = picker.list.querySelectorAll('.emotekit-picker-item img');
    if (typeof IntersectionObserver === 'undefined') { imgs.forEach(loadImage); return; }
    if (picker.observer) picker.observer.disconnect();
    picker.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        loadImage(entry.target);
        picker.observer.unobserve(entry.target);
      }
    }, { root: picker.list, rootMargin: '120px 0px' });
    imgs.forEach((img) => picker.observer.observe(img));
  }

  function filterPicker(query) {
    const q = query.trim().toLowerCase();
    let any = false;
    for (const section of picker.list.querySelectorAll('.emotekit-picker-section')) {
      let shown = 0;
      for (const item of section.querySelectorAll('.emotekit-picker-item')) {
        item.hidden = q !== '' && !item.dataset.code.toLowerCase().includes(q);
        if (!item.hidden) shown++;
      }
      section.hidden = shown === 0;
      const h = section.querySelector('h3');
      h.textContent = `${h.dataset.title} (${shown})`;
      if (shown) any = true;
    }
    picker.list.querySelector('.emotekit-picker-empty').hidden = any;
  }

  function positionPicker() {
    const anchor = picker.button.closest('.chat-input__textarea') || picker.button;
    const r = anchor.getBoundingClientRect();
    const width = Math.min(340, window.innerWidth - 16);
    const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
    picker.panel.style.width = `${width}px`;
    picker.panel.style.left = `${Math.round(left)}px`;
    picker.panel.style.bottom = `${Math.round(window.innerHeight - r.top + 6)}px`;
    picker.panel.style.maxHeight = `${Math.max(200, Math.min(420, r.top - 16))}px`;
  }

  function openPicker() {
    if (!picker.button) return;
    if (!picker.panel || !picker.panel.isConnected) buildPickerPanel();
    if (picker.version !== state.mapVersion || !state.map.size) fillPicker();
    picker.search.value = '';
    filterPicker('');
    picker.panel.style.display = 'flex';
    positionPicker();
    picker.list.scrollTop = 0;
    picker.button.setAttribute('aria-expanded', 'true');
    picker.search.focus();
  }

  function closePicker() {
    if (!picker.panel || picker.panel.style.display !== 'flex') return;
    picker.panel.style.display = 'none';
    if (picker.button) picker.button.setAttribute('aria-expanded', 'false');
    hideTooltip();
  }

  function installPicker() {
    ensurePickerButton();
    // Close on a click outside the picker and its button, or on Escape anywhere.
    document.addEventListener('mousedown', (ev) => {
      if (!picker.panel || picker.panel.style.display !== 'flex') return;
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
    installPicker, ensurePickerButton, openPicker, closePicker, filterPicker, picker,
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
