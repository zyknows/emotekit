# EmoteKit for Twitch

See BetterTTV, FrankerFaceZ and 7TV emotes in Twitch chat on **Safari for Mac**.

BTTV and 7TV don't ship Safari extensions, so in Safari chat is full of words like `OMEGALUL`, `catJAM` and `KEKW` instead of pictures. EmoteKit is a small userscript that loads the emotes each channel has enabled on all three services and shows them in chat, live, in popout chat and in VOD replays.

It's one file, has no dependencies, and also works in Chrome and Firefox with any userscript manager.

## Install (Safari on Mac)

1. Install **[Userscripts](https://github.com/quoid/userscripts)** from the Mac App Store (free, open source; search "Userscripts").
2. In Safari, open **Settings → Extensions**, turn on **Userscripts**, and allow it on `twitch.tv`.
3. Open [`emotekit.user.js`](https://raw.githubusercontent.com/zyknows/emotekit/main/emotekit.user.js) in Safari, click the Userscripts icon in the toolbar, and choose **Install**.
4. Open any Twitch channel. Emotes appear as soon as they load.

**Chrome / Firefox:** install Tampermonkey or Violentmonkey, then open the same link.

## What it does

- Loads **global** emotes from BTTV, FFZ and 7TV, plus the **channel's own** emotes on each service.
- Replaces matching words in chat with the emote image. Matching is exact and case-sensitive, the same as the official extensions.
- Stacks **zero-width emotes** (7TV overlays like `RainTime`, BTTV hats like `SantaHat`) on top of the emote before them.
- Uses 2x images on Retina screens.
- Hover an emote to see its name and which service it's from. Copying chat text keeps the emote names.
- Follows you as you switch channels without a page reload.

When two services have an emote with the same name, the channel's emote wins over a global one, and 7TV wins over BTTV, which wins over FFZ.

## Sending emotes

You don't need anything special: type the emote name in chat and send it. Everyone using EmoteKit, BTTV, FFZ or 7TV sees the picture.

## Privacy

EmoteKit only talks to:

| Service | Why |
| --- | --- |
| `gql.twitch.tv` | Turn the channel name into Twitch's numeric channel ID |
| `api.ivr.fi` | Backup for the above if Twitch's lookup fails |
| `api.betterttv.net`, `api.frankerfacez.com`, `7tv.io` | Emote lists |

It never reads your messages, account or login, and sends nothing anywhere else. Emote images load from each service's CDN.

## Troubleshooting

- **No emotes at all:** check Safari → Settings → Extensions → Userscripts is allowed on `twitch.tv`, then reload the page.
- **Some emotes missing:** open the Web Inspector console (Develop → Show Web Inspector) and look for lines starting with `[EmoteKit]`. It prints how many emotes loaded and which service failed, if any.
- **More detail:** run `localStorage.setItem('emotekit:debug', '1')` in the console and reload.
- **Running BTTV, FFZ or 7TV too?** Turn one off. Two tools replacing the same words can double up.

## Known limitations

- Zero-width emotes stack on BTTV, FFZ and 7TV emotes, but not on native Twitch emotes. Next to a Twitch emote they show side by side.
- No emote picker or tab-completion yet. Typing names works.
- Twitch changes its page layout from time to time. If emotes stop appearing after a Twitch update, please open an issue.

## Roadmap

- Tab-completion for emote names in the chat box
- Emote picker
- Settings panel to turn individual services on or off
- Native Safari extension build (App Store)

## Development

```sh
npm install
npm test
```

The tests run the script in [jsdom](https://github.com/jsdom/jsdom) against mocked API responses: parsers, URL routing, chat rendering, zero-width stacking, failure handling, and the full start-up path.

## Not affiliated

EmoteKit is an independent project. It is not affiliated with or endorsed by Twitch, Apple, BetterTTV, FrankerFaceZ or 7TV. Emotes belong to their creators.

## License

[MIT](LICENSE)
