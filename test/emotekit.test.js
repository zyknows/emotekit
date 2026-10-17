const fs = require('fs');
const assert = require('assert');
const A = (x) => JSON.parse(JSON.stringify(x));
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(require('path').join(__dirname, '..', 'emotekit.user.js'), 'utf8');
let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log('ok  ', name); }
  catch (e) { console.log('FAIL', name, '\n', e); process.exitCode = 1; }
};

// --- Mock API payloads (shapes from the public BTTV / FFZ / 7TV / GQL APIs) ---
const MOCK = {
  'https://api.betterttv.net/3/cached/emotes/global': [
    { id: 'b1', code: 'OMEGALUL', imageType: 'png', animated: false },
    { id: 'b2', code: 'SantaHat', imageType: 'png', animated: false },
    { id: 'b5', code: 'w!', imageType: 'png', animated: false, userId: 'u', modifier: true },
  ],
  'https://api.betterttv.net/3/cached/users/twitch/123': {
    id: 'x', channelEmotes: [{ id: 'b3', code: 'catJAM', imageType: 'gif', animated: true }],
    sharedEmotes: [{ id: 'b4', code: 'pepeD', imageType: 'gif' }],
  },
  'https://api.frankerfacez.com/v1/set/global': {
    default_sets: [3, 1539687],
    users: { 1532818: ['someone'] },
    sets: {
      3: { emoticons: [{ id: 1, name: 'LilZ', urls: { 1: '//cdn.frankerfacez.com/emote/1/1', 2: '//cdn.frankerfacez.com/emote/1/2' }, animated: { 1: 'https://cdn.frankerfacez.com/emote/1/animated/1.webp', 2: 'https://cdn.frankerfacez.com/emote/1/animated/2.webp' } }] },
      4: { emoticons: [{ id: 9, name: 'NotDefault', urls: { 1: 'https://x/1' } }] },
      1539687: { emoticons: [
        { id: 7, name: 'ffzX', modifier: true, modifier_flags: 3, urls: { 1: 'https://cdn.frankerfacez.com/emote/7/1' } },
        { id: 8, name: 'HatZ', modifier: true, modifier_flags: 0, urls: { 1: 'https://cdn.frankerfacez.com/emote/8/1' } },
      ] },
    },
  },
  'https://api.frankerfacez.com/v1/room/id/123': {
    room: { set: 55 },
    sets: { 55: { emoticons: [{ id: 2, name: 'KEKW', urls: { 1: 'https://cdn.frankerfacez.com/emote/2/1' } }, { id: 3, name: 'pepeD', urls: { 1: 'https://ffz/pepeD' } }] } },
  },
  'https://7tv.io/v3/emote-sets/global': {
    emotes: [{ id: 's1', name: 'RainTime', flags: 1, data: { flags: 256, host: { url: '//cdn.7tv.app/emote/s1', files: [{ name: '1x.webp' }, { name: '2x.webp' }] } } }],
  },
  'https://7tv.io/v3/users/twitch/123': {
    emote_set: { emotes: [
      { id: 's2', name: 'Clap', flags: 0, timestamp: Date.now() - 2 * 864e5, data: { flags: 0, animated: true, host: { url: '//cdn.7tv.app/emote/s2', files: [{ name: '1x.webp', static_name: '1x_static.webp' }, { name: '2x.webp', static_name: '2x_static.webp' }] } } },
      { id: 's3', name: 'pepeD', flags: 0, timestamp: Date.now() - 40 * 864e5, data: { flags: 0, host: { url: '//cdn.7tv.app/emote/s3', files: [{ name: '1x.webp' }] } } },
    ] },
  },
};

function mockFetch(log) {
  return async (url, init) => {
    log.push(url);
    let body;
    if (url === 'https://gql.twitch.tv/gql') {
      const q = JSON.parse(init.body);
      assert.strictEqual(init.headers['Client-Id'], 'kimne78kx3ncx6brgo4mv6wki5h1ko');
      body = q.variables.login ? { data: { user: { id: '123', login: q.variables.login } } } : { data: { video: { owner: { id: '123', login: 'somechannel' } } } };
    } else body = MOCK[url];
    return { status: body === undefined ? 404 : 200, text: async () => JSON.stringify(body) };
  };
}

function loadInternals() {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://www.twitch.tv/', runScripts: 'outside-only' });
  dom.window.__EMOTEKIT_TEST__ = {};
  dom.window.eval(SRC);
  return { dom, k: dom.window.__EMOTEKIT_TEST__ };
}

(async () => {
  const { dom, k } = loadInternals();
  const doc = dom.window.document;

  await test('parsers map every provider shape', () => {
    const bttv = k.parseBttv(MOCK['https://api.betterttv.net/3/cached/emotes/global'], 'Global');
    assert.strictEqual(bttv[0].url1x, 'https://cdn.betterttv.net/emote/b1/1x');
    assert.strictEqual(bttv.find((e) => e.code === 'SantaHat').zeroWidth, true);
    assert.strictEqual(k.parseBttvChannel(MOCK['https://api.betterttv.net/3/cached/users/twitch/123']).length, 2);
    assert.deepStrictEqual(A(k.parseBttvChannel(null)), []);

    const ffz = k.parseFfzGlobal(MOCK['https://api.frankerfacez.com/v1/set/global']);
    assert.deepStrictEqual(A(ffz.map((e) => e.code)), ['LilZ', 'HatZ'], 'only default sets, no hidden effect modifiers');
    assert.strictEqual(ffz.find((e) => e.code === 'HatZ').zeroWidth, true, 'visible FFZ modifier is an overlay');
    assert.ok(!bttv.some((e) => e.code === 'w!'), 'BTTV text modifiers are skipped');
    assert.strictEqual(ffz[0].url1x, 'https://cdn.frankerfacez.com/emote/1/animated/1.webp', 'animated version shown by default');
    assert.strictEqual(ffz[0].static1x, 'https://cdn.frankerfacez.com/emote/1/1', 'FFZ still version is the plain urls');
    assert.strictEqual(ffz[0].static2x, 'https://cdn.frankerfacez.com/emote/1/2');
    const catJAM = k.parseBttvChannel(MOCK['https://api.betterttv.net/3/cached/users/twitch/123'])[0];
    assert.strictEqual(catJAM.static1x, 'https://cdn.betterttv.net/emote/b3/static/1x.webp', 'BTTV still version');
    assert.strictEqual(catJAM.static2x, 'https://cdn.betterttv.net/emote/b3/static/2x.webp');
    assert.strictEqual(bttv[0].static1x, null, 'non-animated emotes have no still version');
    assert.strictEqual(k.parseFfzRoom(MOCK['https://api.frankerfacez.com/v1/room/id/123']).length, 2);

    const stv = k.parse7tvGlobal(MOCK['https://7tv.io/v3/emote-sets/global']);
    assert.strictEqual(stv[0].url1x, 'https://cdn.7tv.app/emote/s1/1x.webp');
    assert.strictEqual(stv[0].url2x, 'https://cdn.7tv.app/emote/s1/2x.webp');
    assert.strictEqual(stv[0].zeroWidth, true);
    const user = k.parse7tvUser(MOCK['https://7tv.io/v3/users/twitch/123']);
    const clap = user.find((e) => e.code === 'Clap');
    assert.strictEqual(clap.static1x, 'https://cdn.7tv.app/emote/s2/1x_static.webp', '7TV still version from static_name');
    assert.strictEqual(clap.static2x, 'https://cdn.7tv.app/emote/s2/2x_static.webp');
    assert.strictEqual(stv[0].static1x, null, 'not animated: no still version');
    assert.strictEqual(user.find((e) => e.code === 'pepeD').url2x, null, 'missing 2x file -> null');
  });

  await test('parsers survive garbage', () => {
    assert.deepStrictEqual(A(k.parseBttv({}, 'Global')), []);
    assert.deepStrictEqual(A(k.parseFfzGlobal({ sets: null })), []);
    assert.deepStrictEqual(A(k.parse7tvUser({ emote_set: null })), []);
    assert.deepStrictEqual(A(k.parse7tvGlobal({ emotes: [null, { name: 'x' }] })), []);
  });

  await test('header: version matches package.json, runs in content context', () => {
    const header = SRC.slice(0, SRC.indexOf('==/UserScript=='));
    const pkg = JSON.parse(fs.readFileSync(require('path').join(__dirname, '..', 'package.json'), 'utf8'));
    assert.strictEqual(header.match(/@version\s+(\S+)/)[1], pkg.version);
    assert.match(header, /@inject-into\s+content/);
  });

  await test('channelFromPath', () => {
    const c = k.channelFromPath;
    assert.deepStrictEqual({ ...c('/xQcOW') }, { login: 'xqcow' });
    assert.deepStrictEqual({ ...c('/xqcow/videos') }, { login: 'xqcow' });
    assert.deepStrictEqual({ ...c('/popout/Shroud/chat') }, { login: 'shroud' });
    assert.deepStrictEqual({ ...c('/embed/shroud/chat') }, { login: 'shroud' });
    assert.deepStrictEqual({ ...c('/moderator/shroud') }, { login: 'shroud' });
    assert.deepStrictEqual({ ...c('/videos/v2234567') }, { vodId: '2234567' });
    assert.strictEqual(c('/'), null);
    assert.strictEqual(c('/directory/category/just-chatting'), null);
    assert.strictEqual(c('/settings/profile'), null);
    assert.strictEqual(c('/bad-name!'), null);
  });

  await test('precedence: channel > global, 7TV > BTTV > FFZ', () => {
    const map = k.buildMap([
      [{ code: 'pepeD', provider: 'FFZ' }], [{ code: 'pepeD', provider: 'BTTV' }], [{ code: 'pepeD', provider: '7TV' }],
    ]);
    assert.strictEqual(map.get('pepeD').provider, '7TV');
  });

  // DOM tests use the full mock data merged the way handleRoute does.
  const globals = [
    ...k.parseFfzGlobal(MOCK['https://api.frankerfacez.com/v1/set/global']),
    ...k.parseBttv(MOCK['https://api.betterttv.net/3/cached/emotes/global'], 'Global'),
    ...k.parse7tvGlobal(MOCK['https://7tv.io/v3/emote-sets/global']),
  ];
  const channel = [
    ...k.parseFfzRoom(MOCK['https://api.frankerfacez.com/v1/room/id/123']),
    ...k.parseBttvChannel(MOCK['https://api.betterttv.net/3/cached/users/twitch/123']),
    ...k.parse7tvUser(MOCK['https://7tv.io/v3/users/twitch/123']),
  ];
  k.state.lists = [globals, channel];
  k.applyEmoteLists();

  const msg = (text) => {
    const line = doc.createElement('div');
    line.className = 'chat-line__message';
    line.innerHTML = `<span class="chat-author__display-name">Volkan</span>: <span class="text-fragment" data-a-target="chat-message-text"></span>`;
    line.querySelector('.text-fragment').textContent = text;
    doc.body.appendChild(line);
    return line.querySelector('.text-fragment');
  };

  await test('replaces emote words, keeps other text and spacing', () => {
    const el = msg('lol OMEGALUL that was KEKW  clean');
    k.processFragment(el);
    const emotes = [...el.querySelectorAll('.emotekit-emote')].map((s) => s.dataset.emotekit);
    assert.deepStrictEqual(emotes, ['OMEGALUL', 'KEKW']);
    assert.strictEqual(el.textContent, 'lol  that was   clean');
    const img = el.querySelector('img');
    assert.strictEqual(img.alt, 'OMEGALUL');
    assert.ok(img.srcset.includes('2x'));
  });

  await test('case-sensitive and whole-word only', () => {
    const el = msg('omegalul OMEGALULs xOMEGALUL');
    k.processFragment(el);
    assert.strictEqual(el.querySelectorAll('.emotekit-emote').length, 0);
  });

  await test('shared name resolves to 7TV channel emote', () => {
    const el = msg('pepeD');
    k.processFragment(el);
    assert.strictEqual(el.querySelector('img').src, 'https://cdn.7tv.app/emote/s3/1x.webp');
  });

  await test('zero-width emotes stack on the previous emote', () => {
    const el = msg('catJAM RainTime SantaHat hi');
    k.processFragment(el);
    const wraps = el.querySelectorAll('.emotekit-emote');
    assert.strictEqual(wraps.length, 1);
    assert.strictEqual(wraps[0].querySelectorAll('img').length, 3);
    assert.strictEqual(wraps[0].querySelectorAll('.emotekit-overlay').length, 2);
    assert.strictEqual(el.textContent, ' hi');
  });

  await test('zero-width with nothing to sit on renders normally', () => {
    const el = msg('RainTime lol SantaHat');
    k.processFragment(el);
    assert.strictEqual(el.querySelectorAll('.emotekit-emote').length, 2);
    assert.strictEqual(el.querySelectorAll('.emotekit-overlay').length, 0);
  });

  await test('hover tooltip: appears on mouseover with name, service and overlays; hides on leave', async () => {
    k.installTooltip();
    const el = msg('catJAM RainTime hi');
    k.processFragment(el);
    const wrap = el.querySelector('.emotekit-emote');
    assert.strictEqual(wrap.title, '', 'no slow native title tooltip');
    const over = (target, related) => target.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true, relatedTarget: related }));
    over(wrap.querySelector('img'));
    const tip = doc.querySelector('.emotekit-tooltip');
    assert.ok(tip && tip.style.display === 'block', 'shown immediately');
    assert.strictEqual(tip.querySelector('.emotekit-tooltip-name').textContent, 'catJAM');
    assert.deepStrictEqual([...tip.querySelectorAll('.emotekit-tooltip-meta')].map((d) => d.textContent),
      ['BTTV · Channel emote', '+ RainTime · 7TV Global']);
    assert.deepStrictEqual([...tip.querySelectorAll('.emotekit-tooltip-preview img')].map((i) => i.src),
      ['https://cdn.betterttv.net/emote/b3/2x', 'https://cdn.7tv.app/emote/s1/2x.webp'], 'large images, overlay stacked');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    over(el);
    assert.strictEqual(tip.style.display, 'block', 'stays up briefly after the pointer moves off');
    await wait(150);
    over(wrap);
    await wait(150);
    assert.strictEqual(tip.style.display, 'block', 'coming back before the delay ends keeps it up');
    over(el);
    await wait(260);
    assert.strictEqual(tip.style.display, 'none', 'hidden once the delay has passed');

    const other = msg('KEKW');
    k.processFragment(other);
    over(wrap);
    over(other.querySelector('.emotekit-emote'));
    assert.strictEqual(tip.querySelector('.emotekit-tooltip-name').textContent, 'KEKW', 'switches to another emote immediately');
    await wait(260);
    assert.strictEqual(tip.style.display, 'block', 'no pending hide carried over from the switch');

    over(wrap);
    let underPointer = true; // jsdom has no real pointer, so stub :hover
    const realMatches = wrap.matches;
    wrap.matches = (sel) => (sel === ':hover' ? underPointer : realMatches.call(wrap, sel));
    doc.dispatchEvent(new dom.window.Event('scroll'));
    await wait(260);
    assert.strictEqual(tip.style.display, 'block', 'stays up on scroll while the emote is still under the pointer');
    underPointer = false;
    doc.dispatchEvent(new dom.window.Event('scroll'));
    assert.strictEqual(tip.style.display, 'block', 'still up right after the emote scrolls away');
    await wait(260);
    assert.strictEqual(tip.style.display, 'none', 'hidden once the delay has passed after scrolling away');
  });

  await test('hover tooltip: emote names are shown as text, not HTML', () => {
    const name = '<b>pwn</b>';
    k.state.map.set(name, { code: name, provider: '7TV', source: 'Channel', url1x: 'https://x/1x.webp', url2x: null, zeroWidth: false });
    const el = msg(name);
    k.processFragment(el);
    el.querySelector('.emotekit-emote').dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
    const tip = doc.querySelector('.emotekit-tooltip');
    assert.strictEqual(tip.querySelector('.emotekit-tooltip-name').textContent, name);
    assert.strictEqual(tip.querySelectorAll('b').length, 0, 'no injected markup');
    k.state.map.delete(name);
  });

  await test('idempotent on repeat processing', () => {
    const el = msg('Clap Clap');
    k.processFragment(el);
    const html = el.innerHTML;
    k.processFragment(el); k.processFragment(el);
    assert.strictEqual(el.innerHTML, html);
  });

  await test('observer path: new chat lines and React text rewrites', async () => {
    const obs = new dom.window.MutationObserver(k.onMutations);
    obs.observe(doc.documentElement, { childList: true, subtree: true, characterData: true });
    const el = msg('Clap');
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(el.querySelectorAll('.emotekit-emote').length, 1);
    el.textContent = 'KEKW again'; // React-style in-place rewrite
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(el.querySelector('.emotekit-emote').dataset.emotekit, 'KEKW');
    obs.disconnect();
  });

  await test('does not touch mentions or links outside text fragments', () => {
    const line = doc.createElement('div');
    line.innerHTML = '<span class="mention-fragment">@KEKW</span><a href="#">KEKW</a>';
    doc.body.appendChild(line);
    k.rescan();
    assert.strictEqual(line.querySelectorAll('.emotekit-emote').length, 0);
  });

  // Stand-in for Twitch's Slate chat box: it only changes its text through beforeinput
  // events (like Slate) and re-renders with the caret at the end.
  const fakeChatInput = () => {
    const box = doc.createElement('div');
    box.className = 'chat-input__textarea';
    box.innerHTML = '<div class="row"><div class="slot tw-slot"><button class="tw-btn" aria-label="Emote picker" data-a-target="emote-picker-button" data-test-selector="x"><div class="tw-fig"><svg><path d="M0 0"/></svg></div></button></div></div>';
    const el = doc.createElement('div');
    el.setAttribute('data-a-target', 'chat-input');
    el.setAttribute('contenteditable', 'true');
    el.tabIndex = 0;
    box.prepend(el);
    doc.body.appendChild(box);
    const ed = { el, box, value: '' };
    const render = () => {
      const leaf = doc.createElement('span');
      if (ed.value) { leaf.setAttribute('data-slate-string', 'true'); leaf.textContent = ed.value; } else { leaf.setAttribute('data-slate-zero-width', 'n'); leaf.textContent = '﻿'; }
      el.replaceChildren(leaf);
      if (doc.activeElement !== el) return;
      const r = doc.createRange();
      r.setStart(leaf.firstChild, ed.value ? ed.value.length : 0);
      const sel = dom.window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    };
    el.addEventListener('beforeinput', (e) => {
      e.preventDefault();
      if (e.inputType === 'insertText') ed.value += e.data;
      else if (e.inputType === 'deleteContentBackward') ed.value = [...ed.value].slice(0, -1).join('');
      render();
    });
    ed.type = (text) => { el.focus(); ed.value += text; render(); };
    ed.tab = (shiftKey = false) => {
      const ev = new dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    ed.remove = () => box.remove();
    render();
    return ed;
  };

  const extra = ['peepoSad', 'PepePls', 'pepeLaugh'];
  const withExtraEmotes = (fn) => async () => {
    for (const code of extra) k.state.map.set(code, { code, provider: '7TV', source: 'Global', url1x: `https://x/${code}/1x.webp`, url2x: null, zeroWidth: false });
    try { await fn(); } finally { for (const code of extra) k.state.map.delete(code); }
  };

  await test('tab completion: match order', withExtraEmotes(() => {
    assert.deepStrictEqual(A(k.findCompletions('pe')), ['pepeD', 'peepoSad', 'pepeLaugh', 'PepePls'], 'exact case first, then shorter');
    assert.deepStrictEqual(A(k.findCompletions('PEPE')), ['pepeD', 'PepePls', 'pepeLaugh'], 'case-insensitive fallback');
    assert.deepStrictEqual(A(k.findCompletions('zzz')), []);
  }));

  await test('tab completion: completes, cycles both ways, adds a space', withExtraEmotes(() => {
    k.installCompletion();
    const ed = fakeChatInput();
    ed.type('hi pe');
    assert.strictEqual(ed.tab(), true, 'Tab is taken over so focus stays in chat');
    assert.strictEqual(ed.value, 'hi pepeD ');
    ed.tab();
    assert.strictEqual(ed.value, 'hi peepoSad ');
    ed.tab(); ed.tab();
    assert.strictEqual(ed.value, 'hi PepePls ');
    ed.tab();
    assert.strictEqual(ed.value, 'hi pepeD ', 'wraps around');
    ed.tab(true);
    assert.strictEqual(ed.value, 'hi PepePls ', 'Shift+Tab goes back');
    ed.el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'x', bubbles: true }));
    ed.type('x');
    assert.strictEqual(ed.tab(), false, 'typing ends the cycle; nothing to complete after "x"');
    assert.strictEqual(ed.value, 'hi PepePls x');
    ed.remove();
  }));

  await test('tab completion: leaves Tab alone when there is nothing to complete', () => {
    const ed = fakeChatInput();
    ed.type('hello zzzq');
    assert.strictEqual(ed.tab(), false);
    assert.strictEqual(ed.value, 'hello zzzq');
    ed.type(' @Kek');
    assert.strictEqual(ed.tab(), false, '@mentions are left to Twitch');
    ed.type(' :Kek');
    assert.strictEqual(ed.tab(), false, ':emote search is left to Twitch');
    ed.type(' ');
    assert.strictEqual(ed.tab(), false, 'no word before the caret');
    ed.remove();
  });

  const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
  const inputEvent = (el, value) => { el.value = value; el.dispatchEvent(new dom.window.Event('input')); };
  const headings = (panel) => [...panel.querySelectorAll('h3')].map((h) => h.textContent);
  const itemCodes = (root) => [...root.querySelectorAll('.emotekit-picker-item')].map((i) => i.dataset.code);
  const sectionCodes = (panel, title) => {
    const s = [...panel.querySelectorAll('.emotekit-picker-section')].find((x) => x.querySelector('h3').textContent.startsWith(title));
    return s ? itemCodes(s) : null;
  };

  await test('emote picker: button, sections, search, insert, close', async () => {
    const ed = fakeChatInput();
    k.installPicker();
    const button = doc.querySelector('.emotekit-picker-button');
    assert.ok(button, 'button added');
    assert.strictEqual(button.parentElement.nextElementSibling, doc.querySelector('[data-a-target="emote-picker-button"]').parentElement, 'next to Twitch\'s emote button');
    k.ensurePickerButton();
    assert.strictEqual(doc.querySelectorAll('.emotekit-picker-button').length, 1, 'added only once');
    assert.ok(button.classList.contains('tw-btn') && button.parentElement.classList.contains('tw-slot'), 'copies Twitch\'s button classes so it lines up');
    assert.ok(button.querySelector('.tw-fig rect'), 'Twitch\'s icon wrapper kept, icon swapped');
    assert.strictEqual(doc.querySelectorAll('[data-a-target="emote-picker-button"]').length, 1, 'does not copy Twitch\'s data attributes');
    assert.strictEqual(button.getAttribute('aria-label'), 'EmoteKit emotes');

    button.click();
    const panel = doc.querySelector('.emotekit-picker');
    assert.strictEqual(panel.style.display, 'flex');
    assert.strictEqual(button.getAttribute('aria-expanded'), 'true');
    assert.deepStrictEqual(headings(panel), ['New in this channel (1)', 'Channel · 7TV (2)', 'Channel · BTTV (1)', 'Channel · FFZ (1)', 'Global · 7TV (1)', 'Global · BTTV (2)', 'Global · FFZ (2)']);
    assert.ok(panel.querySelector('.emotekit-picker-hint'), 'hints shown while there are no favourites or stats');
    assert.strictEqual(itemCodes(panel).filter((c) => c === 'pepeD').length, 1, 'shadowed duplicates appear once');
    const clapItem = panel.querySelector('[data-code="Clap"]');
    assert.ok(clapItem.querySelector('img').getAttribute('src'), 'visible images start loading when the picker opens');
    assert.ok(clapItem.classList.contains('emotekit-loading'), 'placeholder while loading');
    clapItem.querySelector('img').dispatchEvent(new dom.window.Event('load'));
    assert.ok(!clapItem.classList.contains('emotekit-loading'), 'placeholder removed once loaded');

    const search = panel.querySelector('.emotekit-picker-search');
    inputEvent(search, 'cl');
    assert.deepStrictEqual(headings(panel), ['Results (1)']);
    assert.deepStrictEqual(itemCodes(panel), ['Clap']);
    inputEvent(search, 'nothing-like-this');
    assert.strictEqual(panel.querySelector('.emotekit-picker-empty').textContent, 'No emotes match.');
    inputEvent(search, '');

    // An emote whose image fails shows its name instead, and still works.
    const kekwImg = panel.querySelector('[data-code="KEKW"] img');
    assert.strictEqual(kekwImg.alt, '', 'no alt text inside the picker');
    kekwImg.dispatchEvent(new dom.window.Event('error'));
    assert.strictEqual(panel.querySelector('[data-code="KEKW"] .emotekit-picker-name').textContent, 'KEKW', 'name shown when the image fails');

    // Click inserts at the caret, with spaces as needed.
    ed.type('nice');
    panel.querySelector('[data-code="KEKW"]').click();
    await tick();
    assert.strictEqual(ed.value, 'nice KEKW ');
    panel.querySelector('[data-code="Clap"]').click();
    await tick();
    assert.strictEqual(ed.value, 'nice KEKW Clap ');

    // Enter in the search box inserts the top result, after moving the caret into the chat box.
    search.focus();
    inputEvent(search, 'lilz');
    const enterDown = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    search.dispatchEvent(enterDown);
    assert.ok(enterDown.defaultPrevented);
    assert.strictEqual(doc.activeElement, search, 'focus stays in search until Enter is released, so the keypress cannot send the message');
    assert.strictEqual(ed.value, 'nice KEKW Clap ');
    search.dispatchEvent(new dom.window.KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    await tick(200);
    assert.strictEqual(ed.value, 'nice KEKW Clap LilZ ');

    doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.strictEqual(panel.style.display, 'none', 'Escape closes');
    button.click();
    assert.strictEqual(panel.style.display, 'flex');
    assert.strictEqual(search.value, '', 'reopens with an empty search');
    doc.body.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
    assert.strictEqual(panel.style.display, 'none', 'click outside closes');
    assert.strictEqual(button.getAttribute('aria-expanded'), 'false');

    // Twitch re-renders the chat box: the button comes back.
    ed.remove();
    const ed2 = fakeChatInput();
    k.ensurePickerButton();
    assert.ok(ed2.box.querySelector('.emotekit-picker-button'), 're-added after re-render');
    ed2.remove();
  });

  await test('popular here: counts chat usage per channel, saves it, and decays it', async () => {
    dom.window.localStorage.clear();
    k.loadUsage('chan-a');
    for (const text of ['KEKW KEKW KEKW Clap', 'KEKW', 'catJAM KEKW', 'Clap']) k.processFragment(msg(text));
    assert.strictEqual(k.usage.scores.get('FFZ:2'), 3, 'counted once per message, not per repeat');
    assert.strictEqual(k.usage.scores.get('7TV:s2'), 2);
    assert.strictEqual(k.usage.scores.get('BTTV:b3'), 1);

    const ed = fakeChatInput();
    k.ensurePickerButton();
    k.openPicker();
    const panel = doc.querySelector('.emotekit-picker');
    assert.deepStrictEqual(sectionCodes(panel, 'Popular here'), ['KEKW', 'Clap', 'catJAM'], 'most used first');
    // Search ranks prefix matches first, then popularity.
    inputEvent(panel.querySelector('.emotekit-picker-search'), 'c');
    assert.deepStrictEqual(itemCodes(panel).slice(0, 2), ['Clap', 'catJAM']);
    k.closePicker();
    assert.deepStrictEqual(A(k.findCompletions('c')), ['Clap', 'catJAM'], 'Tab completion ranks by popularity too');

    // New chat lines arriving through the page observer are counted too.
    const obs = new dom.window.MutationObserver(k.onMutations);
    obs.observe(doc.body, { childList: true, subtree: true });
    const line = doc.createElement('div');
    line.innerHTML = '<span class="chat-author__display-name">x</span>: <span class="text-fragment">catJAM</span>';
    doc.body.appendChild(line);
    await tick();
    obs.disconnect();
    assert.strictEqual(k.usage.scores.get('BTTV:b3'), 2, 'counted via the observer path');

    // A message split around a mention counts each emote once.
    const split = doc.createElement('div');
    split.className = 'chat-line__message';
    split.innerHTML = '<span class="text-fragment">Clap </span><span class="mention-fragment">@x</span><span class="text-fragment"> Clap</span>';
    doc.body.appendChild(split);
    split.querySelectorAll('.text-fragment').forEach((f) => k.processFragment(f));
    assert.strictEqual(split.querySelectorAll('.emotekit-emote').length, 2, 'both rendered');
    assert.strictEqual(k.usage.scores.get('7TV:s2'), 3, 'counted once for the message');

    // Saved per channel and restored.
    k.saveUsage();
    const saved = JSON.parse(dom.window.localStorage.getItem('emotekit:usage:chan-a'));
    assert.strictEqual(saved.s['FFZ:2'], 3);
    k.loadUsage('chan-b');
    assert.strictEqual(k.usage.scores.size, 0, 'other channels start empty');
    // A week-old save counts half.
    saved.t -= 7 * 24 * 3600 * 1000;
    dom.window.localStorage.setItem('emotekit:usage:chan-a', JSON.stringify(saved));
    k.loadUsage('chan-a');
    assert.ok(Math.abs(k.usage.scores.get('FFZ:2') - 1.5) < 0.01, 'halves every week');

    // Only the 40 most recently watched channels keep stats.
    const index = {};
    for (let i = 0; i < 45; i++) {
      index[`old-${i}`] = 1000 + i;
      dom.window.localStorage.setItem(`emotekit:usage:old-${i}`, '{"t":1,"s":{}}');
    }
    dom.window.localStorage.setItem('emotekit:usage-index', JSON.stringify(index));
    k.countUsage('FFZ:2');
    k.saveUsage();
    const kept = Object.keys(JSON.parse(dom.window.localStorage.getItem('emotekit:usage-index')));
    assert.strictEqual(kept.length, 40);
    assert.ok(kept.includes('chan-a'), 'current channel kept');
    assert.strictEqual(dom.window.localStorage.getItem('emotekit:usage:old-0'), null, 'oldest dropped from storage');
    assert.ok(dom.window.localStorage.getItem('emotekit:usage:old-44'), 'recent ones kept');

    // Re-rendering after a hide/show doesn't count again.
    const before = k.usage.scores.get('FFZ:2');
    k.refreshChat();
    assert.strictEqual(k.usage.scores.get('FFZ:2'), before);
    k.loadUsage(null);
    ed.remove();
  });

  await test('favourites: first in the picker, in search and in Tab completion', async () => {
    k.loadUsage(null);
    k.setFavourite('BTTV:b2', true); // SantaHat
    k.setFavourite('FFZ:1', true); // LilZ
    assert.deepStrictEqual(A(JSON.parse(dom.window.localStorage.getItem('emotekit:favourites'))), ['BTTV:b2', 'FFZ:1'], 'saved');
    const ed = fakeChatInput();
    k.ensurePickerButton();
    k.openPicker();
    const panel = doc.querySelector('.emotekit-picker');
    assert.ok(headings(panel)[0].startsWith('Favourites'), 'favourites come first');
    assert.deepStrictEqual(sectionCodes(panel, 'Favourites'), ['SantaHat', 'LilZ'], 'in the order they were added');
    inputEvent(panel.querySelector('.emotekit-picker-search'), 'l');
    assert.strictEqual(itemCodes(panel)[0], 'LilZ', 'a favourite that starts with the search leads');
    assert.ok(itemCodes(panel).indexOf('SantaHat') === -1, 'non-matches are left out');
    inputEvent(panel.querySelector('.emotekit-picker-search'), 'z');
    assert.strictEqual(itemCodes(panel)[0], 'LilZ', 'among contains-matches, the favourite leads');
    k.closePicker();
    k.setFavourite('7TV:s1', true); // RainTime
    assert.strictEqual(k.findCompletions('R')[0], 'RainTime');
    k.setFavourite('BTTV:b2', false);
    k.setFavourite('FFZ:1', false);
    k.setFavourite('7TV:s1', false);
    assert.deepStrictEqual(A(k.getFavourites()), []);
    ed.remove();
  });

  await test('favourites: the star on a picker emote toggles it without inserting', async () => {
    k.loadUsage('chan-star');
    k.processFragment(msg('OMEGALUL'));
    const ed = fakeChatInput();
    ed.type('hi');
    k.ensurePickerButton();
    k.openPicker();
    const panel = doc.querySelector('.emotekit-picker');
    const popularItem = () => [...panel.querySelectorAll('.emotekit-picker-section')]
      .find((x) => x.querySelector('h3').textContent.startsWith('Popular')).querySelector('[data-code="OMEGALUL"]');
    const star = popularItem().querySelector('.emotekit-picker-star');
    assert.strictEqual(star.textContent, '☆');
    star.click();
    await tick();
    assert.ok(k.isFavourite('BTTV:b1'), 'favourited from Popular here');
    assert.strictEqual(ed.value, 'hi', 'clicking the star does not insert the emote');
    assert.deepStrictEqual(sectionCodes(panel, 'Favourites'), ['OMEGALUL'], 'shows up in Favourites right away');
    assert.ok(popularItem().classList.contains('emotekit-is-favourite'), 'marked in Popular here too');
    const groupItem = () => [...panel.querySelectorAll('.emotekit-picker-section')]
      .find((x) => x.querySelector('h3').textContent.startsWith('Global · BTTV')).querySelector('[data-code="OMEGALUL"]');
    assert.ok(groupItem().classList.contains('emotekit-is-favourite'), 'marked in its service section too (reused between renders)');
    assert.strictEqual(popularItem().querySelector('.emotekit-picker-star').textContent, '★');
    assert.strictEqual(popularItem().getAttribute('aria-label'), 'OMEGALUL, favourite');
    // Clicking the emote itself still inserts it.
    popularItem().click();
    await tick(200); // focus was in the search box, so the caret moves to chat first
    assert.strictEqual(ed.value, 'hi OMEGALUL ');
    // Unstar from the Favourites section.
    panel.querySelector('.emotekit-picker-section [data-code="OMEGALUL"] .emotekit-picker-star').click();
    assert.ok(!k.isFavourite('BTTV:b1'));
    assert.strictEqual(sectionCodes(panel, 'Favourites'), null, 'gone from Favourites');
    assert.ok(!groupItem().classList.contains('emotekit-is-favourite'), 'unmarked in its service section');
    // In hide mode a click (even on the star's spot) hides, it doesn't favourite.
    panel.querySelector('.emotekit-picker-hide-toggle').click();
    panel.querySelector('[data-code="OMEGALUL"] .emotekit-picker-star').click();
    assert.ok(!k.isFavourite('BTTV:b1') && k.hidden.has('BTTV:b1'));
    k.setHidden('BTTV:b1', false);
    k.closePicker();
    k.loadUsage(null);
    ed.remove();
  });

  await test('clicking an emote in chat: favourite and hide; clicking a hidden name shows it again', async () => {
    k.installEmoteMenu();
    k.installTooltip();
    const el = msg('pepeD and KEKW RainTime');
    k.processFragment(el);
    const click = (node) => node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    const kekw = () => el.querySelector('[data-emotekit="KEKW"]');

    // Menu lists the emote and the one stacked on it.
    click(kekw().querySelector('img'));
    let menu = doc.querySelector('.emotekit-menu');
    assert.ok(menu, 'menu opens');
    assert.deepStrictEqual([...menu.querySelectorAll('.emotekit-menu-name')].map((n) => n.firstChild.textContent), ['KEKW', 'RainTime']);

    // Favourite stays open and updates.
    const star = menu.querySelector('.emotekit-menu-button');
    star.click();
    assert.strictEqual(star.getAttribute('aria-pressed'), 'true');
    assert.ok(k.isFavourite('FFZ:2'));
    assert.ok(doc.querySelector('.emotekit-menu'), 'still open after favouriting');
    star.click();
    assert.ok(!k.isFavourite('FFZ:2'), 'toggles back');

    // Clicking the same emote again closes; Escape closes too.
    click(kekw());
    assert.ok(!doc.querySelector('.emotekit-menu'), 'second click closes');
    click(kekw());
    doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.ok(!doc.querySelector('.emotekit-menu'), 'Escape closes');

    // Hide: the menu closes, and every KEKW in chat becomes its name as text.
    const other = msg('KEKW too');
    k.processFragment(other);
    click(kekw());
    menu = doc.querySelector('.emotekit-menu');
    [...menu.querySelectorAll('.emotekit-menu-button')].find((b) => b.textContent === 'Hide').click();
    assert.ok(!doc.querySelector('.emotekit-menu'), 'menu closes after hiding');
    assert.ok(k.hidden.has('FFZ:2'));
    assert.deepStrictEqual(A(JSON.parse(dom.window.localStorage.getItem('emotekit:hidden'))), ['FFZ:2'], 'saved');
    for (const m of [el, other]) {
      const word = m.querySelector('.emotekit-hidden-word');
      assert.ok(word && word.textContent === 'KEKW', 'shown as its name');
      assert.ok(!m.querySelector('[data-emotekit="KEKW"]'), 'no image');
    }
    assert.strictEqual(el.textContent, 'pepeD and KEKW RainTime'.replace('pepeD', '').replace('RainTime', ''), 'text kept, word order intact');
    assert.ok(el.querySelector('[data-emotekit="RainTime"]'), 'the overlay that sat on it stays, now on its own');
    assert.ok(!k.findCompletions('KEK').includes('KEKW'), 'left out of Tab completion');

    // New messages show it as text too, and hovering explains how to bring it back.
    const later = msg('KEKW later');
    k.processFragment(later);
    const word = later.querySelector('.emotekit-hidden-word');
    assert.ok(word);
    word.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
    assert.match(doc.querySelector('.emotekit-tooltip').textContent, /Hidden\. Click to show it again\./);

    // Click the name: it comes back everywhere.
    click(word);
    assert.ok(!k.hidden.has('FFZ:2'));
    for (const m of [el, other, later]) {
      assert.ok(m.querySelector('[data-emotekit="KEKW"]'), 'image back');
      assert.ok(!m.querySelector('.emotekit-hidden-word'));
    }
  });

  await test('hide mode in the picker; other tabs stay in sync', async () => {
    const ed = fakeChatInput();
    k.ensurePickerButton();
    k.setHidden('7TV:s3', true); // pepeD (7TV channel)
    k.openPicker();
    const panel = doc.querySelector('.emotekit-picker');
    assert.ok(!itemCodes(panel).includes('pepeD'), 'hidden emotes are not offered');
    const manage = panel.querySelector('.emotekit-picker-manage');
    assert.strictEqual(manage.textContent, '1 hidden emote · Manage');
    manage.click();
    assert.ok(panel.classList.contains('emotekit-hide-mode'));
    const toggle = panel.querySelector('.emotekit-picker-hide-toggle');
    assert.strictEqual(toggle.getAttribute('aria-pressed'), 'true');
    assert.strictEqual(toggle.textContent, 'Done');
    assert.strictEqual(panel.querySelector('.emotekit-picker-notice').hidden, false);
    assert.deepStrictEqual(sectionCodes(panel, 'Hidden'), ['pepeD']);
    assert.ok(panel.querySelector('.emotekit-picker-item[data-code="pepeD"]').classList.contains('emotekit-is-hidden'));

    // Clicking toggles in place; nothing is inserted.
    const chatMsg = msg('Clap');
    k.processFragment(chatMsg);
    const clap = panel.querySelector('[data-code="Clap"]');
    clap.click();
    await tick();
    assert.ok(clap.classList.contains('emotekit-is-hidden') && clap.isConnected, 'dimmed in place');
    assert.ok(chatMsg.querySelector('.emotekit-hidden-word'), 'chat updates right away');
    assert.strictEqual(ed.value, '', 'nothing inserted in hide mode');
    clap.click();
    assert.ok(!clap.classList.contains('emotekit-is-hidden'));
    assert.ok(chatMsg.querySelector('[data-emotekit="Clap"]'));

    toggle.click();
    assert.ok(!panel.classList.contains('emotekit-hide-mode'), 'Done leaves hide mode');
    k.closePicker();

    // Another tab hides KEKW: this tab follows.
    k.installStorageSync();
    dom.window.localStorage.setItem('emotekit:hidden', JSON.stringify(['7TV:s3', 'FFZ:2']));
    dom.window.dispatchEvent(new dom.window.StorageEvent('storage', { key: 'emotekit:hidden' }));
    const m = msg('KEKW');
    k.processFragment(m);
    assert.ok(m.querySelector('.emotekit-hidden-word'), 'synced from the other tab');

    k.setHidden('7TV:s3', false);
    k.setHidden('FFZ:2', false);
    assert.strictEqual(k.hidden.size, 0);
    ed.remove();
  });

  await test('perf: 500 messages x 20 words', () => {
    const els = [];
    for (let i = 0; i < 500; i++) els.push(msg('just some normal chat words here that go on KEKW and on with Clap more words to scan through ok'));
    const t = Date.now();
    els.forEach(k.processFragment);
    const ms = Date.now() - t;
    console.log(`      ${ms}ms`);
    assert.ok(ms < 1500);
  });

  // --- End-to-end: real boot path with mocked network ---
  for (const [path, label] of [['/somechannel', 'live channel'], ['/videos/v2234567', 'VOD'], ['/popout/somechannel/chat', 'popout']]) {
    await test(`boot end-to-end on ${label}`, async () => {
      const d = new JSDOM('<!doctype html><head></head><body><div class="chat-scrollable-area__message-container"></div></body>', {
        url: `https://www.twitch.tv${path}`, runScripts: 'outside-only',
      });
      const log = [];
      d.window.fetch = mockFetch(log);
      const infos = [];
      d.window.console.info = (...a) => infos.push(a.join(' '));
      d.window.eval(SRC);
      const doc2 = d.window.document;
      const container = doc2.querySelector('.chat-scrollable-area__message-container');
      const add = (t) => {
        const s = doc2.createElement('span');
        s.className = 'text-fragment'; s.dataset.aTarget = 'chat-message-text'; s.textContent = t;
        const line = doc2.createElement('div'); line.appendChild(s); container.appendChild(line);
        return s;
      };
      const early = add('early OMEGALUL'); // arrives before emotes load
      await new Promise((r) => setTimeout(r, 50));
      const late = add('catJAM KEKW Clap LilZ');
      await new Promise((r) => setTimeout(r, 10));
      assert.ok(doc2.getElementById('emotekit-style'), 'style injected');
      assert.strictEqual(early.querySelectorAll('.emotekit-emote').length, 1, 'early message rescanned');
      assert.deepStrictEqual([...late.querySelectorAll('.emotekit-emote')].map((s) => s.dataset.emotekit), ['catJAM', 'KEKW', 'Clap', 'LilZ']);
      assert.ok(infos.some((s) => s.includes('emotes ready')), infos.join('|'));
      d.window.close();
    });
  }

  await test('channel without BTTV/7TV accounts still gets globals + FFZ', async () => {
    const d = new JSDOM('<!doctype html><body></body>', { url: 'https://www.twitch.tv/newstreamer', runScripts: 'outside-only' });
    const log = [];
    const base = mockFetch(log);
    d.window.fetch = async (url, init) => (/betterttv.*users|7tv.io\/v3\/users/.test(url) ? { status: 404, text: async () => '{}' } : base(url, init));
    const warns = [];
    d.window.console.warn = (...a) => warns.push(a.join(' '));
    d.window.console.info = () => {};
    d.window.eval(SRC);
    await new Promise((r) => setTimeout(r, 50));
    const s = d.window.document.createElement('span');
    s.className = 'text-fragment'; s.textContent = 'OMEGALUL KEKW catJAM';
    d.window.document.body.appendChild(s);
    await new Promise((r) => setTimeout(r, 10));
    assert.deepStrictEqual([...s.querySelectorAll('.emotekit-emote')].map((x) => x.dataset.emotekit), ['OMEGALUL', 'KEKW']);
    assert.deepStrictEqual(warns, [], '404 is not an error');
    d.window.close();
  });

  await test('one provider down does not break the others', async () => {
    const d = new JSDOM('<!doctype html><body></body>', { url: 'https://www.twitch.tv/somechannel', runScripts: 'outside-only' });
    const base = mockFetch([]);
    d.window.fetch = async (url, init) => { if (url.includes('7tv.io')) throw new Error('down'); return base(url, init); };
    d.window.console.warn = () => {};
    d.window.console.info = () => {};
    d.window.eval(SRC);
    await new Promise((r) => setTimeout(r, 50));
    const s = d.window.document.createElement('span');
    s.className = 'text-fragment'; s.textContent = 'catJAM Clap';
    d.window.document.body.appendChild(s);
    await new Promise((r) => setTimeout(r, 10));
    assert.deepStrictEqual([...s.querySelectorAll('.emotekit-emote')].map((x) => x.dataset.emotekit), ['catJAM']);
    d.window.close();
  });


  await test('uses GM.xmlHttpRequest when the manager provides it (Userscripts on Safari)', async () => {
    const d = new JSDOM('<!doctype html><body></body>', { url: 'https://www.twitch.tv/somechannel', runScripts: 'outside-only' });
    const fetched = [];
    const base = mockFetch([]);
    d.window.fetch = () => { throw new Error('fetch should not be used'); };
    d.window.GM = { xmlHttpRequest(opts) {
      fetched.push(opts.url);
      base(opts.url, { headers: opts.headers, body: opts.data }).then(async (r) => opts.onload({ status: r.status, responseText: await r.text() }));
    } };
    d.window.console.info = () => {};
    d.window.eval(SRC);
    await new Promise((r) => setTimeout(r, 50));
    const s = d.window.document.createElement('span');
    s.className = 'text-fragment'; s.textContent = 'catJAM Clap KEKW';
    d.window.document.body.appendChild(s);
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(s.querySelectorAll('.emotekit-emote').length, 3);
    assert.ok(fetched.includes('https://gql.twitch.tv/gql'));
    d.window.close();
  });

  await test('settings: animation modes swap between still and animated images', async () => {
    const el = msg('Clap OMEGALUL');
    k.processFragment(el);
    const img = () => el.querySelector('[data-emotekit="Clap"] img');
    assert.strictEqual(k.animationMode(), 'always', 'Auto plays animations when Reduce motion is off');
    assert.strictEqual(img().getAttribute('src'), 'https://cdn.7tv.app/emote/s2/1x.webp');

    k.updateSettings({ animation: 'never' });
    assert.strictEqual(img().getAttribute('src'), 'https://cdn.7tv.app/emote/s2/1x_static.webp', 'never: still version');
    assert.strictEqual(img().getAttribute('srcset'), 'https://cdn.7tv.app/emote/s2/1x_static.webp 1x, https://cdn.7tv.app/emote/s2/2x_static.webp 2x');
    assert.strictEqual(el.querySelector('[data-emotekit="OMEGALUL"] img').getAttribute('src'), 'https://cdn.betterttv.net/emote/b1/1x', 'non-animated emotes untouched');
    const fresh = msg('Clap');
    k.processFragment(fresh);
    assert.ok(fresh.querySelector('img').getAttribute('src').endsWith('1x_static.webp'), 'new messages start still');

    k.updateSettings({ animation: 'hover' });
    assert.ok(img().getAttribute('src').endsWith('1x_static.webp'), 'hover: still until hovered');
    k.onHoverPlay({ target: img() });
    assert.strictEqual(img().getAttribute('src'), 'https://cdn.7tv.app/emote/s2/1x.webp', 'plays while hovered');
    k.onHoverPlay({ target: el });
    assert.ok(img().getAttribute('src').endsWith('1x_static.webp'), 'still again when the pointer leaves');

    k.updateSettings({ animation: 'auto' });
    assert.strictEqual(img().getAttribute('src'), 'https://cdn.7tv.app/emote/s2/1x.webp');
    assert.strictEqual(JSON.parse(dom.window.localStorage.getItem('emotekit:settings')).animation, 'auto', 'saved');
  });

  await test('settings: emote size sets the chat emote height', () => {
    k.updateSettings({ size: 'large' });
    assert.strictEqual(doc.documentElement.style.getPropertyValue('--emotekit-size'), '36px');
    k.updateSettings({ size: 'small' });
    assert.strictEqual(doc.documentElement.style.getPropertyValue('--emotekit-size'), '22px');
    k.updateSettings({ size: 'normal' });
    assert.strictEqual(doc.documentElement.style.getPropertyValue('--emotekit-size'), '28px');
  });

  await test('settings: collapse repeated emotes, and switching it re-renders chat', () => {
    k.updateSettings({ collapse: true });
    const el = msg('KEKW KEKW  KEKW KEKW nice Clap Clap catJAM catJAM catJAM RainTime');
    k.processFragment(el);
    const wraps = [...el.querySelectorAll('.emotekit-emote')];
    assert.deepStrictEqual(wraps.map((w) => [w.dataset.emotekit, w.dataset.count || '1']),
      [['KEKW', '4'], ['Clap', '1'], ['Clap', '1'], ['catJAM', '1'], ['catJAM', '1'], ['catJAM', '1']], 'runs of 3+ collapse; 2 stay; an emote with an overlay is not merged');
    assert.strictEqual(wraps[0].querySelector('.emotekit-count').textContent, '×4');
    assert.strictEqual(wraps[5].querySelectorAll('img').length, 2, 'overlay kept on the last one');
    assert.strictEqual(el.textContent.replace(/\s+/g, ' ').trim(), '×4 nice', 'the gaps of the run are gone');

    k.updateSettings({ collapse: false });
    assert.strictEqual(el.querySelectorAll('[data-emotekit="KEKW"]').length, 4, 'turning it off brings the repeats back');
    assert.strictEqual(el.querySelector('.emotekit-count'), null);
    k.updateSettings({ collapse: true });
    assert.strictEqual(el.querySelectorAll('[data-emotekit="KEKW"]').length, 1, 'and on again collapses existing chat');
    k.updateSettings({ collapse: false });
  });

  await test('settings view: gear, choices and checkboxes', async () => {
    const ed = fakeChatInput();
    k.ensurePickerButton();
    k.openPicker();
    const panel = doc.querySelector('.emotekit-picker');
    const gear = panel.querySelector('.emotekit-picker-settings-toggle');
    gear.click();
    const view = panel.querySelector('.emotekit-settings');
    assert.ok(view && !view.hidden, 'settings shown');
    assert.ok(panel.querySelector('.emotekit-picker-list').hidden, 'emote list hidden meanwhile');
    assert.strictEqual(gear.getAttribute('aria-pressed'), 'true');
    assert.deepStrictEqual([...view.querySelectorAll('h3')].map((h) => h.textContent), ['Animated emotes', 'Emote size in chat', 'Services', 'Busy chat', 'Chat box']);
    const checked = () => [...view.querySelectorAll('[aria-checked="true"]')].map((b) => b.dataset.value);
    assert.deepStrictEqual(checked(), ['auto', 'normal']);
    view.querySelector('[data-value="never"]').click();
    assert.deepStrictEqual(checked(), ['never', 'normal']);
    assert.strictEqual(k.getSettings().animation, 'never');
    const boxes = [...view.querySelectorAll('input[type="checkbox"]')];
    assert.deepStrictEqual(boxes.map((b) => b.checked), [true, true, true, false, true]);
    boxes[3].checked = true;
    boxes[3].dispatchEvent(new dom.window.Event('change'));
    assert.strictEqual(k.getSettings().collapse, true);

    // Another tab changes a setting: this tab and its open settings view follow.
    k.installStorageSync();
    dom.window.localStorage.setItem('emotekit:settings', JSON.stringify({ ...k.getSettings(), size: 'large', collapse: false }));
    dom.window.dispatchEvent(new dom.window.StorageEvent('storage', { key: 'emotekit:settings' }));
    assert.deepStrictEqual(checked(), ['never', 'large']);
    assert.strictEqual(boxes[3].checked, false);

    // Typing a search goes back to the emotes.
    const search = panel.querySelector('.emotekit-picker-search');
    search.value = 'cl';
    search.dispatchEvent(new dom.window.Event('input'));
    assert.ok(view.hidden && !panel.querySelector('.emotekit-picker-list').hidden);
    gear.click();
    panel.querySelector('.emotekit-picker-hide-toggle').click();
    assert.ok(view.hidden, 'Hide emotes also leaves settings');
    k.closePicker();
    k.updateSettings({ animation: 'auto', size: 'normal', collapse: false });
    ed.remove();
  });

  await test('settings: a service turned off is not contacted and its emotes stay text', async () => {
    const d = new JSDOM('<!doctype html><body></body>', { url: 'https://www.twitch.tv/somechannel', runScripts: 'outside-only' });
    d.window.localStorage.setItem('emotekit:settings', JSON.stringify({ services: { bttv: false } }));
    const log = [];
    d.window.fetch = mockFetch(log);
    d.window.console.info = () => {};
    d.window.eval(SRC);
    await tick(50);
    assert.ok(!log.some((u) => u.includes('betterttv')), 'no BTTV requests');
    assert.ok(log.some((u) => u.includes('7tv.io')) && log.some((u) => u.includes('frankerfacez')));
    const span = d.window.document.createElement('span');
    span.className = 'text-fragment';
    span.textContent = 'catJAM KEKW';
    d.window.document.body.appendChild(span);
    await tick(10);
    assert.deepStrictEqual([...span.querySelectorAll('.emotekit-emote')].map((x) => x.dataset.emotekit), ['KEKW']);

    // Turned back on (here from another tab): only BTTV is fetched, and its emotes appear.
    const before = log.length;
    d.window.localStorage.setItem('emotekit:settings', JSON.stringify({ services: { bttv: true, ffz: true, seventv: true } }));
    d.window.dispatchEvent(new d.window.StorageEvent('storage', { key: 'emotekit:settings' }));
    await tick(50);
    assert.deepStrictEqual(log.slice(before).filter((u) => u !== 'https://gql.twitch.tv/gql'),
      ['https://api.betterttv.net/3/cached/emotes/global', 'https://api.betterttv.net/3/cached/users/twitch/123'], 'other services come from cache');
    assert.deepStrictEqual([...span.querySelectorAll('.emotekit-emote')].map((x) => x.dataset.emotekit), ['catJAM', 'KEKW']);

    // Off again: no requests at all, and catJAM goes back to text.
    const before2 = log.length;
    d.window.localStorage.setItem('emotekit:settings', JSON.stringify({ services: { bttv: false, ffz: true, seventv: true } }));
    d.window.dispatchEvent(new d.window.StorageEvent('storage', { key: 'emotekit:settings' }));
    await tick(50);
    assert.deepStrictEqual(log.slice(before2), [], 'turning a service off makes no requests');
    assert.deepStrictEqual([...span.querySelectorAll('.emotekit-emote')].map((x) => x.dataset.emotekit), ['KEKW']);
    d.window.close();
  });

  await test('new in this channel: recent 7TV additions, newest first, and the tooltip says when', async () => {
    const user = k.parse7tvUser(MOCK['https://7tv.io/v3/users/twitch/123']);
    assert.ok(user.find((e) => e.code === 'Clap').addedAt > 0, '7TV timestamp kept');
    assert.strictEqual(k.parseBttv(MOCK['https://api.betterttv.net/3/cached/emotes/global'], 'Global')[0].addedAt, undefined, 'other services have no date');
    const ed = fakeChatInput();
    k.ensurePickerButton();
    k.openPicker();
    const panel = doc.querySelector('.emotekit-picker');
    assert.deepStrictEqual(sectionCodes(panel, 'New in this channel'), ['Clap'], 'added 2 days ago: listed; 40 days ago: not');
    const clap = panel.querySelector('.emotekit-picker-section [data-code="Clap"] .emotekit-emote');
    clap.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
    assert.match(doc.querySelector('.emotekit-tooltip').textContent, /Added 2 days ago/);
    k.closePicker();
    ed.remove();
  });

  await test('tab completion strip: shows the matches while cycling, hides when done', withExtraEmotes(() => {
    k.installCompletion();
    const ed = fakeChatInput();
    ed.type('hi pe');
    ed.tab();
    const strip = doc.querySelector('.emotekit-completions');
    assert.ok(strip && !strip.hidden, 'shown');
    assert.strictEqual(doc.querySelector('.emotekit-compose').style.display, 'flex');
    const codes = () => [...strip.querySelectorAll('.emotekit-emote')].map((w) => w.dataset.emotekit);
    assert.deepStrictEqual(codes(), ['pepeD', 'peepoSad', 'pepeLaugh', 'PepePls']);
    assert.strictEqual(strip.querySelector('.emotekit-current').dataset.emotekit, 'pepeD');
    assert.strictEqual(strip.querySelector('.emotekit-completions-label').textContent, 'pepeD · 1/4');
    ed.tab();
    assert.strictEqual(strip.querySelector('.emotekit-current').dataset.emotekit, 'peepoSad');
    assert.strictEqual(strip.querySelector('.emotekit-completions-label').textContent, 'peepoSad · 2/4');
    ed.tab(); ed.tab();
    assert.deepStrictEqual(codes(), ['pepeD', 'peepoSad', 'pepeLaugh', 'PepePls'], 'all shown while they fit');
    assert.strictEqual(strip.querySelector('.emotekit-current').dataset.emotekit, 'PepePls', 'the current one is in the row');
    ed.el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    assert.ok(strip.hidden, 'hidden once you keep typing');
    ed.remove();
  }));

  await test('tab completion strip: with many matches, the row starts just before the current one', () => {
    const many = Array.from({ length: 12 }, (_, i) => `zq${String(i).padStart(2, '0')}`);
    for (const code of many) k.state.map.set(code, { key: `T:${code}`, code, provider: '7TV', source: 'Global', url1x: `https://x/${code}.webp`, url2x: null, zeroWidth: false });
    const ed = fakeChatInput();
    ed.type('zq');
    for (let i = 0; i < 6; i++) ed.tab(); // current: zq05
    const strip = doc.querySelector('.emotekit-completions');
    const codes = [...strip.querySelectorAll('.emotekit-emote')].map((w) => w.dataset.emotekit);
    assert.deepStrictEqual(codes, ['zq03', 'zq04', 'zq05', 'zq06', 'zq07', 'zq08', 'zq09', 'zq10', 'zq11'], 'nine shown; the window stops at the end of the list');
    assert.strictEqual(strip.querySelector('.emotekit-completions-label').textContent, 'zq05 · 6/12');
    ed.tab(); ed.tab(); ed.tab(); ed.tab(); ed.tab(); ed.tab(); ed.tab(); // wraps to zq00
    assert.strictEqual([...strip.querySelectorAll('.emotekit-emote')][0].dataset.emotekit, 'zq00');
    ed.el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    for (const code of many) k.state.map.delete(code);
    ed.remove();
  });

  await test('message preview: shows the message with emotes while typing, only when it has emotes', async () => {
    const ed = fakeChatInput();
    k.watchChatInput();
    k.loadUsage('chan-preview'); // counting on, to check previews don't count
    ed.type('hello there');
    await tick(80);
    const preview = () => doc.querySelector('.emotekit-preview');
    assert.ok(!preview() || preview().hidden, 'no emotes: no preview');
    ed.type(' KEKW Clap');
    await tick(80);
    assert.ok(!preview().hidden, 'shown');
    assert.strictEqual(preview().textContent.replace(/\s+/g, ' ').trim(), 'hello there', 'text kept, emotes as images');
    assert.deepStrictEqual([...preview().querySelectorAll('.emotekit-emote')].map((w) => w.dataset.emotekit), ['KEKW', 'Clap']);
    assert.strictEqual(k.usage.channel, 'chan-preview');
    assert.strictEqual(k.usage.scores.size, 0, 'previews are not counted as chat usage');

    // Hidden while the picker is open.
    k.ensurePickerButton();
    k.openPicker();
    assert.strictEqual(doc.querySelector('.emotekit-compose').style.display, 'none');
    k.closePicker();
    ed.el.focus();
    await tick(80);
    assert.strictEqual(doc.querySelector('.emotekit-compose').style.display, 'flex');

    // Leaving the chat box hides it; the setting turns it off.
    ed.el.blur();
    await tick(80);
    assert.ok(preview().hidden, 'hidden when the chat box loses focus');
    ed.el.focus();
    await tick(80);
    k.updateSettings({ preview: false });
    assert.ok(preview().hidden, 'setting off');
    k.updateSettings({ preview: true });
    assert.ok(!preview().hidden);

    // Sent (box cleared): gone.
    ed.value = '';
    ed.type('');
    await tick(80);
    assert.ok(preview().hidden);
    k.loadUsage(null);
    ed.remove();
  });

  await test('damaged saved settings do not stop the script', async () => {
    const d = new JSDOM('<!doctype html><body></body>', { url: 'https://www.twitch.tv/somechannel', runScripts: 'outside-only' });
    d.window.localStorage.setItem('emotekit:hidden', '5');
    d.window.localStorage.setItem('emotekit:favourites', '{"oops":true}');
    d.window.localStorage.setItem('emotekit:usage-index', 'not json');
    d.window.localStorage.setItem('emotekit:usage:123', '{"t":"x","s":null}');
    d.window.localStorage.setItem('emotekit:settings', '{"animation":"sideways","size":7,"services":"no"}');
    d.window.fetch = mockFetch([]);
    const infos = [];
    d.window.console.info = (...a) => infos.push(a.join(' '));
    const errors = [];
    d.window.addEventListener('error', (e) => errors.push(e.message));
    d.window.eval(SRC);
    await tick(50);
    assert.deepStrictEqual(errors, []);
    assert.ok(infos.some((x) => x.includes('emotes ready')), 'started normally');
    d.window.close();
  });

  console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
  dom.window.close();
})();
