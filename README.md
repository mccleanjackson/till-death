# Till Death Do Us Part — live murder mystery

A phone-first, synchronized murder mystery for 10 guests (5 couples). Everyone opens a personal link on their phone; the host releases evidence rounds, opens accusations and reveals the murderer from the same app — no paper.

**Stack:** React + Vite static site (GitHub Pages) → Supabase free tier (Postgres functions). No billing, no service-account keys.

## What's public vs private

| Where | What | Safe to publish? |
|---|---|---|
| this repo (`src/`, `supabase/schema.sql`, `scripts/`, `test/`) | app code, DB structure, practice story | ✅ yes — contains no real story |
| `../private/story.json` | the real mystery + solution | ❌ never — spoilers |
| `../private/seed.sql`, `../private/codes.json` | encoded story + invite codes | ❌ never — codes are passwords |

The real story lives **outside** this folder on purpose. In Supabase it's stored base64-encoded in a non-public schema, and browsers can only reach it through functions that check the player's code and the current phase. The murderer's instructions only go to the murderer's phone; the solution only leaves the database after the host taps **Reveal**.

> The host is also a player. Don't open `../private/story.json`, don't decode the `td_private.stories` table, and don't use other guests' links.

## How a game runs

- **Phases:** Lobby → Round 1 → Round 2 → Round 3 → Accusations → Reveal. Only the host can move them; a double tap can't skip a round; "Undo" goes back one step.
- **Joining:** each guest taps their link (`…/#/j/CODE`) and types their first name. Same link works on any phone, any time — nothing to lose if a phone dies.
- **Phones update by themselves** every ~3 seconds, with a banner + vibration when a round unlocks.
- **Tabs:** Home · My Card (sealed envelope + secrets, unlocking new memories each round) · Suspects (with private notes per person) · Clues (evidence + case notes) · Accuse.
- **Accusations** are one per player and locked once sent. The host sees "7/10 voted" and who's still waiting (not what they voted).
- **Reveal** shows the murderer, the explanation, who solved it, and everyone's accusations.
- Two games exist: `practice` (a 5-minute silly test mystery — use it to rehearse) and `party` (the real one). They have different links.

## Setup (one time)

1. **Supabase:** create a free project. In *SQL Editor*, run `supabase/schema.sql`, then run `../private/seed.sql`.
2. **Config:** copy `.env.example` to `.env` and fill in the Project URL and anon/publishable key from *Project Settings → API* (both are public by design).
3. **Seed file:** `node scripts/make-seed.mjs --host avery --url https://USER.github.io/REPO/` regenerates `../private/seed.sql` and prints the host's two links. Re-running keeps the same invite codes.
4. **Build & publish:** `npm run build`, then publish only `dist/` to the `gh-pages` branch (`npx gh-pages -d dist`). Enable Pages on that branch.

## Night-of checklist

1. Host opens their **party** link → Home → *Show guest links* → **Send link** next to each name (opens the phone's share sheet).
2. Everyone joins and enters their name. Wait for **10/10 joined**.
3. Give people ~10 minutes to read their card. Then **Start the game** (Round 1).
4. ~20–25 minutes per round → **Release Round 2**, **Release Round 3**.
5. **Open accusations**. Wait for **10/10 voted**.
6. **Reveal the murderer**.

## Development

```bash
npm install
npm test            # 10-player simulation against the real SQL (in-memory Postgres)
npm run mock        # local stand-in for Supabase on :54399 (practice story only)
npx vite --mode mock  # app pointed at the mock (uses .env.mock)
```
