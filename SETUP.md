# Daily Work Portal — setup guide

The portal runs on three free services plus one pay-per-use AI account:

| Piece | Service | What it does |
|---|---|---|
| Website | **GitHub Pages** (this repository) | Secure https address, so GPS and voice typing work on phones |
| Database + logins | **Supabase** | Shared data for everyone, real passwords, GPS readable only by CEO/GM |
| Emails | **Resend** | Meeting reminders and action emails |
| AI | **Anthropic (Claude API)** | MoM drafts, meeting prep, management summary |

Expect 2–3 hours the first time. These services change their screens now and then, so a button may have a slightly different name than written here.

---

## Part 1 — Website (GitHub Pages)

1. In this repository: **Settings → Pages**.
2. Under **Build and deployment**, Source: **Deploy from a branch**. Branch: **main**, folder **/ (root)**. Click **Save**.
3. After a minute the page shows your address, normally `https://abhiaydi.github.io/daily-work-portal/`. Keep it; it's used below as **PORTAL URL**.

## Part 2 — Database and logins (Supabase)

1. Go to **supabase.com** → **Start your project** → sign in (you can use your GitHub account).
2. **New project**: name `daily-work-portal`, create a strong database password (save it somewhere safe), choose the region closest to the UAE, click **Create**. Wait until it finishes.
3. **SQL Editor → New query**. Open `supabase/schema.sql` from this repository, copy everything, paste, click **Run**. It should say *Success*.
4. **Staff list:** open the private file `people-seed.sql` (sent to you separately, **never upload it to GitHub**). Replace every `@CHANGE-ME` email with that person's real work email. Paste it into a new SQL query and **Run**.
5. **Authentication → Sign In / Providers → Email**: switch **off** "Allow new users to sign up" (only you add people). Save.
6. **Authentication → URL Configuration**: set **Site URL** to your PORTAL URL, and add the same address under **Redirect URLs**. Save. (Needed for "Forgot password?" emails.)
7. **Authentication → Users → Add user → Create new user**, for each person: their work email (the same one as in the staff list), a temporary password, and tick **Auto Confirm User**. Tell each person their temporary password; they can change it in the portal by tapping their name (top right).
8. **Project Settings → API** (or the **Connect** button): copy the **Project URL** and the **anon / public** key. If you see both "Publishable key" and "Legacy API keys", use the legacy **anon** key.
9. In this repository open **config.js** → pencil icon (Edit) → paste the two values in place of `YOUR-PROJECT-REF...` and `YOUR-ANON-OR-PUBLISHABLE-KEY` → **Commit changes**. These two values are meant to be public; the database's security rules protect the data.

Open the PORTAL URL: you can now log in. Sales staff get the location login; the GM and CEO see their locations on the dashboard.

## Part 3 — Emails (Resend)

1. Sign up at **resend.com**.
2. **Domains → Add domain** → your company domain. Resend shows a few DNS records; add them where your domain's DNS is managed (the company that runs your website/email can do this), then click **Verify**.
   Until the domain is verified, Resend only delivers to your own sign-up email, which is fine for testing.
3. **API Keys → Create API key** → copy it.

## Part 4 — AI (Claude API)

1. Sign up at **console.anthropic.com**, add a payment method (billed per use; see their pricing page).
2. **API Keys → Create key** → copy it.

## Part 5 — Secrets for the server functions (Supabase)

In Supabase: **Edge Functions → Secrets** (sometimes under Project Settings → Edge Functions). Add:

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | the key from Part 4 |
| `RESEND_API_KEY` | the key from Part 3 |
| `EMAIL_FROM` | e.g. `Daily Work Portal <portal@yourcompany.com>` (must use the verified domain) |
| `PORTAL_URL` | your PORTAL URL |
| `AI_MODEL` | optional; leave out to use the default model set in `supabase/functions/ai/index.ts` |

## Part 6 — Deploy the server functions

Already done: the three functions (ai, notify, reminders) are deployed to the Supabase project. Use the steps below only if you ever need to redeploy them from GitHub.

1. Supabase: click your avatar → **Account preferences → Access Tokens → Generate new token** → copy it.
2. This repository: **Settings → Secrets and variables → Actions → New repository secret**, add:
   - `SUPABASE_ACCESS_TOKEN` = the token from step 1
   - `SUPABASE_PROJECT_REF` = the letters in your Project URL between `https://` and `.supabase.co`
3. **Actions** tab → **Deploy server functions** → **Run workflow**. Wait for the green tick. (It also runs by itself whenever the functions change.)

## Part 7 — Turn on reminder emails

Already done: the every-minute schedule is set up in the database. The steps below are for setting it up again in a new project.

1. Open `supabase/cron.sql` from this repository, copy it.
2. In Supabase **SQL Editor → New query**, paste, replace `YOUR-PROJECT-REF` with your value, **Run**.
   Reminders are checked every minute from then on.

## Part 8 — Check it works

- Log in as a salesperson on a phone → **Log in** → allow location → the GM's dashboard shows the login time and location under **Field sales**.
- Schedule a meeting for 20 minutes from now → reminder emails arrive at 15 and 10 minutes before.
- In a meeting, write diary points → the GM sees them live under **Sales meetings**.
- Tap **Write MoM with AI** → a draft appears.

If something doesn't work, note which step and what you see (a screenshot helps).
