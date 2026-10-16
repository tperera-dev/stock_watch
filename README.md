# Stock Watch

Price alarms for a watchlist of US and Australian stocks, in two parts:

- **Server (GitHub Actions):** checks prices every 30 minutes while each market is open and sends a push alert to your phone when a ticker goes below or above your alarm price.
- **Phone app (GitHub Pages):** an installable Android app where you add tickers, set alarm prices and receive the alarms.

Prices come from Yahoo Finance, with Google Finance as a backup. Everything runs on free GitHub features.

## How it fits together

| Part | Where | What it does |
|---|---|---|
| `.github/workflows/price-alarm.yml` | GitHub Actions | Runs the check on a schedule, or when you tap **Check now** / **Test alarm** in the app |
| `scripts/check.mjs` | GitHub Actions | Gets prices, decides which alarms fire, sends one Web Push alert listing them |
| `docs/` | GitHub Pages | The phone app (`index.html`), its push receiver (`sw.js`) and the public `status.json` |

Your settings live in GitHub, not in public files:

| Name | Kind | Set by |
|---|---|---|
| `WATCHLIST` | repository variable | the app, when you add or edit tickers |
| `PUSH_SUBSCRIPTION` | repository variable | the app, when you tap **Enable alerts** |
| `VAPID_PUBLIC_KEY` | repository variable | the app, the first time you enable alerts |
| `VAPID_PRIVATE_KEY` | repository **secret** | the app, the first time you enable alerts |

## Setup

### 1. Put the files in place
- The workflow file must live at `.github/workflows/price-alarm.yml`. If it's in a `move-to-github-workflows` folder, move it there and delete that folder.
- Commit and push everything to the `main` branch.

### 2. Turn on the phone app
On github.com: **Settings → Pages →** Source **Deploy from a branch**, Branch **main**, folder **/docs**, **Save**.
After a minute the app is at **https://tperera-dev.github.io/stock_watch/**.
The repo needs to be public for Pages on a free account. See *Privacy* below for what that exposes.

### 3. Create a GitHub token for the app
Go to [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new):
- **Expiration:** pick a date, for example 1 year.
- **Repository access:** *Only select repositories* → `stock_watch`.
- **Repository permissions:** **Actions**, **Secrets** and **Variables** → *Read and write*. Leave everything else as is.
- Generate it and copy the token.

### 4. Install the app on your phone
1. Open https://tperera-dev.github.io/stock_watch/ in **Chrome on Android**.
2. Chrome menu → **Install app** (or **Add to Home screen**).
3. Open **Stock Watch** from your home screen → **Settings** → paste the token → **Save**.
4. Tap **Enable alerts on this phone** and allow notifications.
5. Tap **Test alarm**. An alert should arrive within about a minute.

### 5. Add tickers
Tap **+ Add ticker**, enter a symbol and an alarm price below, above, or both.
- US stocks: the normal ticker, for example `AMD` or `NVDA`.
- Australian stocks: add `.AX`, for example `BHP.AX` or `CBA.AX`.
- Up to 25 tickers. Tap a card to edit, pause or remove it.

### Make the alarm louder (optional)
Android **Settings → Apps → Stock Watch** (or **Chrome**) **→ Notifications** → the Stock Watch channel → **Sound**: choose an alarm tone. You can also let it override Do Not Disturb, which helps because US market hours are overnight in Sydney.

## How alarms behave
- **When checks run:**
  - US tickers: weekdays 9:30 am–4:00 pm New York time.
  - ASX tickers: weekdays 10:00 am–4:00 pm Sydney time.
  - Daylight saving and market holidays are handled automatically.
- **When an alarm fires:**
  - Each alarm alerts once when the price crosses it. It re-arms after the price moves back, and changing an alarm price also re-arms it.
  - If several tickers cross on the same check, you get one alert listing them all.
- **On the phone:**
  - The notification vibrates and stays on screen until you dismiss it.
  - Tapping it opens a full-screen alarm with a looping sound and a **Stop alarm** button. If Android blocks the sound, tap **Play alarm sound**.
- **Delays and failures:**
  - GitHub can start scheduled runs 5–15 minutes late when it's busy.
  - If every price lookup fails, the run shows red in the **Actions** tab and GitHub emails you.

## Privacy
Public, because the repo is public:
- the code
- `docs/status.json`: the tickers you watch and their recent prices

Not public:
- **Your alarm prices.** They're kept in the `WATCHLIST` variable, and the alert state in `status.json` is encrypted.
- **Your token.** It's stored only on your phone.
- **Your push keys and phone registration.**

Without your push key, nobody can send alerts to your phone. Without your token, nobody can change your settings. If you lose your phone, delete the token at github.com/settings/personal-access-tokens.

## Keeping it running
- **60-day pause:** GitHub pauses scheduled workflows after 60 days without repository activity. Each check commits `docs/status.json`, which counts as activity. If checks ever stop, open **Actions** and re-enable the workflow.
- **Token expiry:** when the token expires, the app will say so. Create a new token and paste it in Settings.
- **Alerts stop arriving:** if the app says alerts expired, tap **Enable alerts** again.

## Testing locally
```bash
npm ci
WATCHLIST='[{"symbol":"AMD","below":540},{"symbol":"BHP.AX","above":48}]' \
MOCK_PRICES='{"AMD":530,"BHP.AX":49}' FORCE=true DRY_RUN=true VAPID_PRIVATE_KEY=test \
node scripts/check.mjs
```

Quotes from free sources can be delayed. This is a convenience tool, not financial advice.
