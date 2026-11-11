# Deploying PayQA to Render

`render.yaml` sets up three free web services:

| Service | What it is |
|---|---|
| `payqa` | The dashboard and test engine |
| `payqa-store-buggy` | Demo store with the 4 planted bugs |
| `payqa-store-fixed` | The same store with the bugs fixed |

## Steps

1. Push the repo (including `render.yaml`) to GitHub.
2. Sign in at [render.com](https://render.com) with GitHub.
3. **New → Blueprint**, then connect the `payqa` repository. Render reads `render.yaml` and lists the three services.
4. Fill in the secret values when asked:
   - `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`: from the PayPal developer dashboard (sandbox)
   - `ANTHROPIC_API_KEY`: from platform.claude.com
5. Click **Apply** and wait for the three services to build and go live (about 5 minutes).
6. Check the stores' URLs in the Render dashboard. If they aren't exactly `https://payqa-store-buggy.onrender.com` and `https://payqa-store-fixed.onrender.com`, open the `payqa` service → **Environment**, and update `PAYQA_BUGGY_STORE_URL` and `PAYQA_FIXED_STORE_URL`. Saving redeploys it.
7. Open the `payqa` service's URL and run **Chaos** on both demo stores.

## How the hosted demo differs from running locally

- **Chaos Mode only.** Browser Mode drives a real Chrome, which needs more memory and CPU than Render's free tier provides. Run it locally (see the README).
- **Only the demo stores can be tested** (`PAYQA_LOCK_STORES=true`), so the public server can't be pointed at other sites.
- **At most 30 runs per hour** (`PAYQA_MAX_RUNS_PER_HOUR`), to protect the Claude API budget.
- **Free services sleep after 15 minutes without traffic.** The first run after a quiet spell can take about a minute while the stores wake up. The dashboard starts waking them as soon as the page opens.
- Run history isn't kept across restarts.
