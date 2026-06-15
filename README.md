# Equinix Intelligence Hub

Seven AI agents for marketing intelligence: customer listening, competitive listening, media & analyst listening, counternarrative synthesis, content strategy & 90-day plan, campaign architecture, and vertical variations.

---

## Deploy to Vercel (15 minutes)

### Prerequisites
- [Node.js](https://nodejs.org) installed (v18+)
- An [Anthropic API key](https://console.anthropic.com)
- A free [Vercel account](https://vercel.com/signup)
- A free [GitHub account](https://github.com) (to connect Vercel)

---

### Step 1 — Put the project on GitHub

1. Go to [github.com/new](https://github.com/new)
2. Create a new **private** repository called `intelligence-hub`
3. Don't initialize with README
4. Copy the two commands it gives you (they look like `git remote add origin ...`)

Then in your terminal, from the folder containing these files:

```bash
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/YOUR_USERNAME/intelligence-hub.git
git push -u origin main
```

---

### Step 2 — Deploy to Vercel

1. Go to [vercel.com/new](https://vercel.com/new)
2. Click **Import Git Repository** and connect your GitHub account
3. Select the `intelligence-hub` repo
4. Vercel will auto-detect the settings — leave everything as default
5. Click **Deploy**

Your app will be live at `https://intelligence-hub-XXXX.vercel.app` in about 60 seconds.

---

### Step 3 — Add your Anthropic API key

1. In your Vercel dashboard, go to your project → **Settings** → **Environment Variables**
2. Click **Add New**
3. Name: `ANTHROPIC_API_KEY`
4. Value: your API key from [console.anthropic.com](https://console.anthropic.com)
5. Make sure **Production**, **Preview**, and **Development** are all checked
6. Click **Save**
7. Go to **Deployments** → click the three dots on your latest deployment → **Redeploy**

The hub is now live and authenticated.

---

### Step 4 — Test it

Open your Vercel URL, click **Run sweep** on the Customer tab, and you should see results in 15–30 seconds.

---

## How to update

Edit any file locally, commit, and push to GitHub — Vercel redeploys automatically in ~60 seconds.

```bash
git add .
git commit -m "updated agent prompts"
git push
```

---

## Project structure

```
intelligence-hub/
├── api/
│   └── anthropic.js     ← Vercel serverless proxy (keeps API key server-side)
├── public/
│   └── index.html       ← The full hub UI
├── package.json
├── vercel.json
└── README.md
```

---

## Customizing agent prompts

All four agent prompts live in the `<script>` block of `public/index.html` in the `PROMPTS` object. Edit them directly — change personas, add competitors, adjust topic areas — then push to GitHub to redeploy.

---

## Local development

```bash
npm install
npx vercel dev
```

Then open `http://localhost:3000`. You'll need a `.env.local` file:

```
ANTHROPIC_API_KEY=your_key_here
```

---

## Automated weekly brief (GitHub Actions)

The full pipeline runs unattended every **Monday at 8:00am Pacific** and emails the brief
(all seven agents: the three sweeps, synthesis, content strategy, campaign, and verticals).
It runs as a GitHub Action — not on Vercel — so the multi-step pipeline isn't constrained by
serverless function timeouts.

- Workflow: [`.github/workflows/weekly-brief.yml`](.github/workflows/weekly-brief.yml)
- Pipeline script: [`scripts/weekly-brief.mjs`](scripts/weekly-brief.mjs)

### One-time setup — add repository secrets

In GitHub: **Settings → Secrets and variables → Actions → New repository secret**. Add:

| Secret | Required | Notes |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | Same key the app uses |
| `RESEND_API_KEY` | yes | Your Resend API key |
| `BRIEF_RECIPIENT_EMAIL` | yes | The inbox the brief is sent to |
| `BRIEF_FROM_EMAIL` | optional | Defaults to `Intelligence Hub <onboarding@resend.dev>` |

### Schedule & daylight saving

GitHub cron is UTC, so the workflow fires at **both** 15:00 and 16:00 UTC on Mondays.
The script checks the actual `America/Los_Angeles` time and only sends when it's 08:xx —
so exactly one brief goes out at 8am Pacific whether it's PST or PDT. The off-target trigger
exits quietly.

### Test it now

Go to the repo's **Actions → Weekly Intelligence Brief → Run workflow**. Manual runs set
`FORCE_RUN=true`, which bypasses the time guard and sends immediately — useful for confirming
your secrets and email delivery without waiting for Monday.
