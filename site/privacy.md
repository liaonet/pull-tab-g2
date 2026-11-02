# Pull Tab privacy notice

Last updated: October 26, 2026 (Pull Tab 0.1.9). Pull Tab is an Even G2 app made by Bill Liao. It connects your glasses to **your own Tab assistant**.

## What Pull Tab collects

Pull Tab has no account, no analytics, no ads and no tracking. It handles only:

- **Your voice recordings.** The glasses microphone (permission `g2-microphone`) records only after you triple-tap the temple or ring to start. Recording stops when you triple-tap to send, double-tap to exit, if nothing is said for 8 seconds, or at 55 seconds (that recording is thrown away, not sent).
- **A pairing secret.** The app makes it on your phone on first open and keeps it in the app's local storage on your phone.
- **Battery levels** of your glasses (and of your ring, if the Even app reports it), read from the Even app only to show them at the top of the lens with the time and date. They stay on your phone and are never sent anywhere.

## Where your recording goes

1. Your phone encrypts each recording (AES-256-GCM) with a key derived from your pairing secret. Only your phone and your own Tab hold that key. You give the pairing secret to your Tab once, in your chat with it, and your Tab keeps it in its private storage. Don't share or forward that chat. Pull Tab clears the copied setup message from your phone's clipboard after 30 seconds.
2. The encrypted recording goes, using the `network` permission, straight to **your own relay**: a small private service your Tab runs for you at an address ending in `.sites.tab.bot`. This is the only place the app contacts. There is no Pull Tab server in between, and the developer never receives your recordings. The app checks that every reply from your relay is signed by it (with a key that comes from your pairing secret) and refuses anything else, so no other website can pose as your relay. Like any website, your relay's hosting sees your phone's internet address when the app connects.
3. Your relay holds the encrypted recording until your Tab picks it up (up to 8 recordings can wait, first in, first out), and sends your Tab a short notification email for each. That email contains no audio, words or keys. Your Tab then decrypts the recording, transcribes it in memory and answers you by message (on WhatsApp or by text, in your usual chat with it). Answers never go through Pull Tab or your relay.
4. Your relay deletes the recording as soon as your Tab answers, or as soon as you cancel it (a triple tap while "Sent" is on the lens cancels only that recording). Anything left over is never served after 30 minutes and is erased the next time your relay is used. The relay's hosting keeps encrypted history of its database for up to 30 days; only your pairing code can open it.

Once your Tab has decrypted a recording, your words are handled like anything else you tell your Tab, under your own agreement with Tab (tab.bot), including by the services and AI models your Tab runs on. Pull Tab doesn't change that agreement.

## Your choices

- **Disconnect:** tap "Reset pairing" and send the new setup message to your Tab: your Tab shuts down the old relay, so the old code stops working. Or uninstall Pull Tab and ask your Tab to shut down and delete your relay.
- **Delete your data:** recordings are deleted automatically, as described above. Uninstalling the app clears its local storage.

## Hosting

Pull Tab has no server of its own. Each relay runs as a small Worker on Tab's site hosting (`*.sites.tab.bot`), published by your own Tab on your own Tab account. This notice and the setup guide are plain web pages at pulltab.sites.tab.bot.

## Contact

Questions: the Pull Tab Discord (link in the store listing), or contact the developer through the Even Hub listing.
