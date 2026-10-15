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
    id: 'x', channelEmotes: [{ id: 'b3', code: 'catJAM', imageType: 'gif' }],
    sharedEmotes: [{ id: 'b4', code: 'pepeD', imageType: 'gif' }],
  },
  'https://api.frankerfacez.com/v1/set/global': {
    default_sets: [3, 1539687],
    users: { 1532818: ['someone'] },
    sets: {
      3: { emoticons: [{ id: 1, name: 'LilZ', urls: { 1: '//cdn.frankerfacez.com/emote/1/1', 2: '//cdn.frankerfacez.com/emote/1/2' } }] },
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
      { id: 's2', name: 'Clap', flags: 0, data: { flags: 0, host: { url: '//cdn.7tv.app/emote/s2', files: [{ name: '1x.webp' }, { name: '2x.webp' }] } } },
      { id: 's3', name: 'pepeD', flags: 0, data: { flags: 0, host: { url: '//cdn.7tv.app/emote/s3', files: [{ name: '1x.webp' }] } } },
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
    assert.strictEqual(ffz[0].url1x, 'https://cdn.frankerfacez.com/emote/1/1');
    assert.strictEqual(k.parseFfzRoom(MOCK['https://api.frankerfacez.com/v1/room/id/123']).length, 2);

    const stv = k.parse7tvGlobal(MOCK['https://7tv.io/v3/emote-sets/global']);
    assert.strictEqual(stv[0].url1x, 'https://cdn.7tv.app/emote/s1/1x.webp');
    assert.strictEqual(stv[0].url2x, 'https://cdn.7tv.app/emote/s1/2x.webp');
    assert.strictEqual(stv[0].zeroWidth, true);
    const user = k.parse7tvUser(MOCK['https://7tv.io/v3/users/twitch/123']);
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
  k.state.map = k.buildMap([globals, channel]);

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
    await wait(250);
    assert.strictEqual(tip.style.display, 'block', 'coming back before the delay ends keeps it up');
    over(el);
    await wait(350);
    assert.strictEqual(tip.style.display, 'none', 'hidden once the delay has passed');

    const other = msg('KEKW');
    k.processFragment(other);
    over(wrap);
    over(other.querySelector('.emotekit-emote'));
    assert.strictEqual(tip.querySelector('.emotekit-tooltip-name').textContent, 'KEKW', 'switches to another emote immediately');
    await wait(350);
    assert.strictEqual(tip.style.display, 'block', 'no pending hide carried over from the switch');

    over(wrap);
    let underPointer = true; // jsdom has no real pointer, so stub :hover
    const realMatches = wrap.matches;
    wrap.matches = (sel) => (sel === ':hover' ? underPointer : realMatches.call(wrap, sel));
    doc.dispatchEvent(new dom.window.Event('scroll'));
    await wait(350);
    assert.strictEqual(tip.style.display, 'block', 'stays up on scroll while the emote is still under the pointer');
    underPointer = false;
    doc.dispatchEvent(new dom.window.Event('scroll'));
    assert.strictEqual(tip.style.display, 'block', 'still up right after the emote scrolls away');
    await wait(350);
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

  console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
  dom.window.close();
})();
