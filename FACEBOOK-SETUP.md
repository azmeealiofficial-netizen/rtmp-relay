# Facebook match automation — setup

One call starts a match on both pages; one call ends it. After this is set up
you never open Live Producer again.

```
POST /api/match/start   { "title": "FAM Atoll Championship — R. Inguraidhoo vs Dhuvaafaru" }
POST /api/match/end     {}
GET  /api/match/status
```

---

## What the endpoints actually do

`/api/match/start`

1. Creates a live video on **both** pages with `status: UNPUBLISHED` — nothing is
   visible on either page yet.
2. Writes VOICE's stream key into the OBS stream service, and Dhuvas's into the
   Branch Output filter on the DHUVAS scene.
3. `StartStream`.
4. Ten seconds later, checks OBS is genuinely streaming, then flips both
   broadcasts to `LIVE_NOW`.

The unpublished-first order is deliberate. `LIVE_NOW` publishes the post the
instant it's created, so if anything failed after that you'd have a live post on
both pages showing viewers a spinner. This way a failure leaves two unpublished
drafts nobody sees, and `/api/match/start` rolls them back automatically.

If OBS doesn't come up, the broadcasts stay unpublished and `lastError` says so.
`POST /api/match/publish` forces the publish manually if you want it anyway.

`/api/match/end` stops OBS first, then closes both broadcasts. It returns
`{ ok, errors }` and always clears local state, so a Facebook-side failure never
leaves the relay thinking a match is still running.

---

## Getting the tokens (once)

You need a **Page access token** for each page. Page tokens derived from a
long-lived user token don't expire, so this is a one-time job.

### 1. Create a Meta app

developers.facebook.com → My Apps → **Create App** → type **Business**.
Note the **App ID** and **App Secret** (Settings → Basic).

Leave the app in **Development mode**. Because you're both the app admin and an
admin of both pages, the permissions below work without App Review. App Review is
only needed if someone without a role on the app needs to use it — which for a
relay only you run, never happens.

### 2. Generate a user token with the right scopes

Open the **Graph API Explorer** (developers.facebook.com/tools/explorer):

- Meta App: your new app
- User or Page: **User Token**
- Add permissions:
  - `pages_show_list`
  - `pages_read_engagement`
  - `pages_manage_posts`
  - `publish_video`

Click **Generate Access Token** and approve. This token is short-lived (1–2 hours)
— that's fine, it's only used for step 3.

### 3. Exchange it for a long-lived user token

```
GET https://graph.facebook.com/v25.0/oauth/access_token
      ?grant_type=fb_exchange_token
      &client_id=YOUR_APP_ID
      &client_secret=YOUR_APP_SECRET
      &fb_exchange_token=THE_SHORT_TOKEN
```

Returns a token valid ~60 days.

### 4. Get the page tokens

```
GET https://graph.facebook.com/v25.0/me/accounts
      ?access_token=THE_LONG_LIVED_USER_TOKEN
```

Returns every page you administer, each with its `id` and its own `access_token`.
Take both — that also gives you the **Dhuvas page ID**, which we don't have yet.
(VOICE is `248813165823102`.)

### 5. Confirm the page tokens never expire

```
GET https://graph.facebook.com/v25.0/debug_token
      ?input_token=THE_PAGE_TOKEN
      &access_token=THE_LONG_LIVED_USER_TOKEN
```

`expires_at` should be **0**. If it isn't, the user token you exchanged from
wasn't long-lived — redo step 3.

### 6. Put them in Railway

On the **rtmp-relay** service → Variables:

```
FB_VOICE_PAGE_ID    = 248813165823102
FB_VOICE_TOKEN      = <VOICE page token>
FB_DHUVAS_PAGE_ID   = <from step 4>
FB_DHUVAS_TOKEN     = <Dhuvas page token>
```

Optional:

```
FB_API_VERSION      = v25.0    (default)
FB_PUBLISH_DELAY_MS = 10000    (default — wait before flipping to LIVE_NOW)
```

Redeploy, then check:

```
GET https://mix.vxd.news/api/match/status
```

`configured` should read `{ voice: true, dhuvas: true }`.

---

## Testing it without broadcasting to the world

The safest rehearsal is to point both pages at a quiet moment and end it quickly —
there's no test mode through the API the way there is in Live Producer.

1. `GET /api/match/status` → confirm `configured` is true for both
2. `POST /api/match/start` with a throwaway title
3. Watch both pages — video should appear within ~15 seconds
4. `POST /api/match/end`
5. Delete both posts from each page

If step 3 shows nothing, `GET /api/match/status` and read `lastError`.

---

## Known sharp edges

**Stream settings can't change while streaming.** `/api/match/start` refuses if
OBS is already live, rather than silently failing. Stop the stream first.

**One match at a time.** Starting while a match is live returns 409. Use
`/api/match/end` first — the relay won't let you orphan a pair of broadcasts.

**A relay restart loses match state.** Railway redeploys mid-match would leave
`matchState` empty, so `/api/match/end` would stop OBS but not close the Facebook
broadcasts — you'd end those from the page. Worth moving to Postgres alongside the
scoreboard state if this ever bites; the table pattern is already there.

**Token revocation is silent.** If you change your Facebook password or remove the
app, the page tokens die and `/api/match/start` fails with a Graph error at the
first call. Nothing is created, so there's nothing to clean up — but check
`/api/match/status` before a big match rather than discovering it at kickoff.
