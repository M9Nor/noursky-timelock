---
description: End-of-session handoff — update context docs, secrets-check, commit, push
---

You are ending a work session on NourSky TimeClock. Produce a clean handoff so the
next session (possibly on a different Claude Code account) can resume with full context.

Do this in order:

1. **Update `docs/PROGRESS.md`:**
   - Rewrite **Current State** (branch, last deploy status, what works, what's broken).
   - Rewrite **In Progress** (the task and the exact point where work stopped, files touched).
   - Rewrite **Next Steps** (prioritized, concrete, actionable).
   - Update **Open Questions / Blockers** if any changed.
   - Prepend a new **Session Log** entry (newest on top): today's date, a one-line
     summary, files changed, and the commit hash (fill the hash in after committing).

2. **Update `docs/DECISIONS.md`** only if an architectural/technical decision was made
   this session: append it (date, decision, reason, alternatives rejected).

3. **Secrets check on staged changes.** Stage the intended files, then scan for secrets:
   ```bash
   git add -A
   git diff --cached | grep -inE "(password|secret|api[_-]?key|token|BEGIN [A-Z]+ PRIVATE KEY)\s*[:=]?\s*['\"][^'\"]{8,}" || echo "no obvious secrets"
   git diff --cached --name-only | grep -E "(^|/)\.env($|\.)" && echo "WARNING: an .env file is staged — unstage it" || echo "no .env staged"
   ```
   If anything real is found, STOP, unstage it, and tell the user — do not commit.

4. **Commit and push:**
   ```bash
   git -c user.name="Mohammed Nour" -c user.email="azer9nor@gmail.com" commit -m "chore(context): session handoff

   Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
   git push origin HEAD
   ```

5. **Report** the commit hash and a one-line summary of what changed.
