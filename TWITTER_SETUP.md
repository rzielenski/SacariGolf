# Sacari Twitter / X Daily Digest

An automated once-a-day recap tweet from a Sacari-owned X account. It summarises
the day on the app: rounds played, balls lost to the water, the round of the day,
and the player who lost the most balls ("Richard lost 13 balls today").

## What got built

| Piece | File |
| --- | --- |
| OAuth 1.0a tweet poster (dependency-free) | `backend/src/utils/tweet.ts` |
| Digest builder + daily scheduler | `backend/src/utils/twitterDigest.ts` |
| Opt-in column + idempotency table (migrations) | `backend/src/db/migrate.ts` |
| Opt-in toggle on the profile API | `backend/src/routes/users.ts` (`PATCH /users/me { shareToTwitter }`) |
| Scheduler wired into boot | `backend/src/index.ts` |
| Signature + content tests | `backend/tests/oauthSignature.test.js`, `backend/tests/digestCompose.test.js` |

The job is **inert until the four `TWITTER_*` env vars are set**. No keys, no
tweets, and nothing else in the app is affected.

## Privacy model (opt-in)

A player is **only ever named after they opt in**. The DB column
`users.share_to_twitter` defaults to `FALSE`. Everyone who has not opted in is
folded into anonymous app-wide totals, e.g. "Someone out there lost 13 balls
today." Toggle it per account via:

```
PATCH /users/me   { "shareToTwitter": true }
```

(`GET /users/me` returns `share_to_twitter` so a settings screen can show the
current state. The mobile toggle UI is the one remaining piece; see "Next" below.)

## Getting the four API keys (about 10 minutes)

1. **Create the bot's X account.** Sign up at https://x.com for the account that
   will do the posting (e.g. `@SacariGolf`). Use an email and phone you control.
2. **Apply for a developer account.** Go to https://developer.x.com, sign in **as
   that account**, and sign up for the **Free** plan. Free allows ~1,500 posts per
   month, which is far more than one tweet a day. Answer the use-case prompt with
   something like: "Automated daily activity recap for my golf app, posting to my
   own account."
3. **Create a Project + App.** In the developer portal: **Projects & Apps → New
   Project** (or use the default project) and create an App inside it.
4. **Set the App permissions to Read and Write.** In the App's **Settings → User
   authentication settings**, enable OAuth 1.0a, set **App permissions = Read and
   Write**, App type = **Web App / Automated App or Bot**. Callback URL and
   website can be `https://sacari.app` (any valid URL). Save. This step matters:
   if the App is Read-only, posting returns 403.
5. **Generate the keys.** In the App's **Keys and tokens** tab:
   - **API Key and Secret** (a.k.a. Consumer Keys) → this is `TWITTER_API_KEY`
     and `TWITTER_API_SECRET`.
   - **Access Token and Secret** → click **Generate**. Make sure it reads
     "Created with Read and Write permissions". These are `TWITTER_ACCESS_TOKEN`
     and `TWITTER_ACCESS_SECRET`. (If you changed permissions in step 4 *after*
     generating these, regenerate them, otherwise they stay Read-only.)

Copy all four somewhere safe. They are shown once.

## Configure Railway

In the backend service on Railway → **Variables**, add:

```
TWITTER_API_KEY=<API Key>
TWITTER_API_SECRET=<API Secret>
TWITTER_ACCESS_TOKEN=<Access Token>
TWITTER_ACCESS_SECRET=<Access Token Secret>
```

Optional tuning (sensible defaults shown):

```
DIGEST_TZ=America/New_York   # timezone for "today" and the post time
DIGEST_HOUR=20               # hour (0-23) after which the day's recap posts
```

Redeploy. On boot you will see one of:

- `[digest] daily Twitter digest scheduled.` (keys present), or
- `[digest] TWITTER_* env not set, daily digest disabled.` (keys missing)

## How it runs

- A tick every 15 minutes calls the digest job.
- Once the local clock passes `DIGEST_HOUR`, it builds and posts **one** tweet,
  then records the date in the `digest_log` table so a restart or a later tick
  never double-posts.
- Quiet days (no rounds, no balls lost) are recorded but not tweeted.
- Posting is best-effort: a failed post is left unrecorded and retried on the
  next tick.

## Verifying

```
cd backend
npm run build
node tests/oauthSignature.test.js   # proves the OAuth 1.0a signature is spec-correct
node tests/digestCompose.test.js    # prints a sample tweet, checks the privacy rule
```

To smoke-test against the live API once keys are set, you can temporarily set
`DIGEST_HOUR=0` so the next tick posts immediately, confirm the tweet, then put
`DIGEST_HOUR` back to `20`.

## Cost

The **Free** X tier (~1,500 posts/month) covers one daily tweet with enormous
headroom. You only need the paid Basic tier ($200/mo) if you later switch to
tweeting many times per day.

## Next (optional)

- A **settings toggle** in the mobile app that calls `PATCH /users/me { shareToTwitter }`
  so players can opt in from their phone (backend already supports it).
- More digest flavours (longest drive, biggest ELO mover, hottest streak). The
  composing logic lives in `composeDigest()` and is unit-tested, so adding lines
  is low-risk.
