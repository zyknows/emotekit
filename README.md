# EmoteKit for Twitch

A userscript that shows BetterTTV, FrankerFaceZ and 7TV emotes in Twitch chat.

BTTV and 7TV have no Safari extension, so in Safari these emotes show up as plain text (`OMEGALUL`, `catJAM`, `KEKW`). EmoteKit replaces them with the images. It works in live chat, popout chat and VOD chat replay.

It is a single file with no dependencies. It also works in Chrome and Firefox with a userscript manager.

## Install (Safari on Mac)

1. Install [Userscripts](https://github.com/quoid/userscripts) from the Mac App Store.
2. In Safari, open **Settings → Extensions**, enable **Userscripts**, and allow it on `twitch.tv`.
3. Open [`emotekit.user.js`](https://raw.githubusercontent.com/zyknows/emotekit/main/emotekit.user.js), click the Userscripts toolbar icon, and choose **Install**.
4. Open a Twitch channel.

**Chrome / Firefox:** install Tampermonkey or Violentmonkey, then open the same link.

## Behaviour

- Loads global emotes and the current channel's emotes from BTTV, FFZ and 7TV.
- Replaces exact, case-sensitive matches in chat messages.
- Zero-width emotes (for example 7TV `RainTime`) are drawn on top of the emote before them.
- Uses 2x images on high-DPI screens.
- Hovering an emote shows its name and source. Copied chat text keeps the emote names.
- Reloads emotes when you switch channels.

If two emotes share a name, a channel emote is used over a global one, and 7TV is used over BTTV, which is used over FFZ.

To send an emote, type its name in chat. Anyone with EmoteKit, BTTV, FFZ or 7TV sees the image.

## Network requests

| Host | Purpose |
| --- | --- |
| `gql.twitch.tv` | Look up the channel's Twitch user ID |
| `api.ivr.fi` | Fallback for the lookup above |
| `api.betterttv.net`, `api.frankerfacez.com`, `7tv.io` | Emote lists |

Emote images load from each service's CDN. The script does not read messages or account data.

## Troubleshooting

- **No emotes:** check that Userscripts is allowed on `twitch.tv` (Safari → Settings → Extensions), then reload.
- **Some emotes missing:** open the Web Inspector console (Develop → Show Web Inspector) and look for `[EmoteKit]` lines. They show how many emotes loaded and which service failed.
- **Debug logging:** run `localStorage.setItem('emotekit:debug', '1')` in the console and reload.
- **Duplicated emotes:** disable BTTV, FFZ or 7TV if you also run one of them.

## Known limitations

- Zero-width emotes stack on BTTV, FFZ and 7TV emotes, not on native Twitch emotes.
- BTTV text modifiers (`w!`, `h!`, ...) and FFZ effect emotes (`ffzW`, `ffzX`, ...) are not applied and stay as text.
- No emote picker or tab-completion.
- Changes to Twitch's page layout can stop emotes from appearing. Please open an issue if that happens.

## Planned

- Tab-completion for emote names
- Emote picker
- Per-service on/off settings
- Native Safari extension

## Development

```sh
npm install
npm test
```

Tests run the script in [jsdom](https://github.com/jsdom/jsdom) against mocked API responses.

## Disclaimer

Not affiliated with Twitch, Apple, BetterTTV, FrankerFaceZ or 7TV. Emotes belong to their creators.

## License

[MIT](LICENSE)
