---
description: Start-of-session briefing — pull, read context docs, summarize, ask what to start
---

You are starting a work session on NourSky TimeClock, possibly on a different account
than the last session. Load context before doing anything.

Do this in order:

1. **Pull latest:**
   ```bash
   git pull --ff-only || git pull
   ```

2. **Read, in full:** `CLAUDE.md`, `docs/PROGRESS.md`, `docs/DECISIONS.md`.
   (For deep detail, `PROJECT.md` is the source of truth — read only if needed.)

3. **Give a short briefing** (do NOT write code yet):
   - **Current state:** branch, last deploy status, what works / what's broken.
   - **Where work stopped:** the "In Progress" item and its exact stopping point.
   - **Top 3 next steps** from PROGRESS.md, in priority order.

4. **Ask which next step to start with.** Wait for the answer before touching any code.
