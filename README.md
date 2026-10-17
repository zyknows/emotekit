# EmoteKit for Twitch

A userscript that brings BetterTTV, FrankerFaceZ and 7TV emotes to Twitch chat, along with the tools to find, send and control them.

- **All three emote services** in live chat, popout chat and VOD replays, with zero-width emotes stacked and a hover preview.
- **An emote picker that knows each channel:** your favourites first, then the emotes this channel's chat actually uses, then what the channel added recently, then everything, with search.
- **Favourite or hide any emote** with one click in chat or in the picker. Hidden emotes turn into their name, which you can click to bring them back.
- **Faster typing:** Tab completion ranked by what you and the channel use, with a strip showing the matches, and a live preview of your message with emotes.
- **Your chat, your way:** animated emotes always, on hover or never; three emote sizes; any service turned off; repeated emotes collapsed into one with a count.
- **Private and light:** no account, no tracking, nothing about your chat leaves your browser. About 0.2 ms of CPU per chat message, and still emotes cut emote downloads on a busy channel from 9.5 MB to 0.5 MB in the first minute.

One file, no dependencies. Built for Safari on Mac, where BTTV and 7TV have no extension; also works in Chrome and Firefox with a userscript manager.

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
- Hovering an emote immediately shows a larger preview, its name and service, and any zero-width emotes on it.
- Copied chat text keeps the emote names.
- **Tab completion:** type the start of an emote name in the chat box and press Tab. Press Tab again for the next match, Shift+Tab for the previous one. Matching ignores case; favourites and the channel's most used emotes come first. While you cycle, a strip above the chat box shows the matches, with the current one outlined and its position (for example `LOL · 2/12`).
- **Message preview:** while you type a message that contains emotes, a line above the chat box shows it the way it will look in chat. It can be turned off in the settings.
- **Emote picker:** the grid button next to Twitch's emote button opens your favourites, then the emotes this channel's chat uses most ("Popular here"), then the 7TV emotes the channel added in the last 14 days ("New in this channel"), then every channel and global emote by service. Search ranks names that start with what you type first, then favourites and popular ones. Click an emote, or press Enter in the search box, to add it to your message.
- **Favourite or hide an emote:** click it in chat, or in the picker hover an emote and click the star in its corner. Favourites appear first in the picker and in Tab completion, and are marked with a gold star in the rest of the picker. A hidden emote shows as its name in chat; hover it to see it highlighted, and click it to bring the emote back. The picker's **Hide emotes** button lists your hidden emotes and lets you hide or show any emote by clicking it.
- **Settings** (gear button in the picker):
  - **Animated emotes:** Auto, Always, On hover or Never. Auto plays animations unless Reduce motion is on in macOS's accessibility settings; then they play when you hover them. Still emotes download much less: on a busy channel, about 0.5 MB in the first minute instead of 9.5 MB.
  - **Emote size in chat:** Small, Normal or Large.
  - **Services:** turn BetterTTV, FrankerFaceZ or 7TV off. A service that is off is not contacted.
  - **Collapse repeated emotes** (off by default): `KEKW KEKW KEKW` shows as one KEKW ×3.
  - **Preview my message with emotes** (on by default).
- Reloads emotes when you switch channels.

If two emotes share a name, a channel emote is used over a global one, and 7TV is used over BTTV, which is used over FFZ.

Anyone with EmoteKit, BTTV, FFZ or 7TV sees the emotes you send.

## Network requests

| Host | Purpose |
| --- | --- |
| `gql.twitch.tv` | Look up the channel's Twitch user ID |
| `api.ivr.fi` | Fallback for the lookup above |
| `api.betterttv.net`, `api.frankerfacez.com`, `7tv.io` | Emote lists |

Emote images load from each service's CDN. The script does not read your account and sends nothing about chat anywhere.

### Stored in your browser

To rank the picker, EmoteKit counts how often each emote appears in the chats you watch. The counts (for your 40 most recent channels), your favourites, your hidden emotes and your settings are saved in your browser's storage for twitch.tv and never leave it.

## Troubleshooting

- **No emotes:** check that Userscripts is allowed on `twitch.tv` (Safari → Settings → Extensions), then reload.
- **Some emotes missing:** open the Web Inspector console (Develop → Show Web Inspector) and look for `[EmoteKit]` lines. They show how many emotes loaded and which service failed.
- **Debug logging:** run `localStorage.setItem('emotekit:debug', '1')` in the console and reload.
- **Duplicated emotes:** disable BTTV, FFZ or 7TV if you also run one of them.

## Known limitations

- Zero-width emotes stack on BTTV, FFZ and 7TV emotes, not on native Twitch emotes.
- BTTV text modifiers (`w!`, `h!`, ...) and FFZ effect emotes (`ffzW`, `ffzX`, ...) are not applied and stay as text.
- Changes to Twitch's page layout can stop emotes from appearing. Please open an issue if that happens.

## Planned

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
