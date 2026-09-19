/**
 * postinstall: build the React frontend into ../public so Hostinger serves it.
 *
 * Runs automatically after `npm install` at the repo root. Guards:
 *  - Skips when there is no web/ directory (nothing to build).
 *  - Skips inside CI-less recursion: the web/ install triggers its own
 *    lifecycle scripts, but web/package.json has no postinstall, so there is
 *    no loop. As a belt-and-braces guard we also bail if cwd is already web/.
 *  - Set SKIP_WEB_BUILD=1 to skip entirely (e.g. backend-only smoke runs).
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const webDir = join(root, "web");

if (process.env.SKIP_WEB_BUILD === "1") {
  console.log("[build-web] SKIP_WEB_BUILD=1 — skipping frontend build");
  process.exit(0);
}
if (basename(process.cwd()) === "web") {
  process.exit(0); // guard against running from inside web/
}
if (!existsSync(webDir)) {
  console.log("[build-web] no web/ directory — skipping frontend build");
  process.exit(0);
}

console.log("[build-web] installing web/ deps and building into public/ …");
const cmd = process.platform === "win32" ? "npm.cmd" : "npm";
// The host installs the root in production mode, which npm would inherit into
// web/'s install and skip devDependencies — but vite lives there. So INSTALL
// with NODE_ENV=development + --include=dev to get the toolchain, then BUILD
// with NODE_ENV=production so Vite emits a production bundle (import.meta.env.DEV
// === false, which hides the dev-login screen). Mixing these up ships dev mode.
const installEnv = { ...process.env, NODE_ENV: "development" };
const buildEnv = { ...process.env, NODE_ENV: "production" };
const install = spawnSync(cmd, ["install", "--include=dev", "--no-audit", "--no-fund"], {
  cwd: webDir, stdio: "inherit", env: installEnv,
});
if (install.status !== 0) {
  console.error("[build-web] web/ npm install failed");
  process.exit(install.status ?? 1);
}
const build = spawnSync(cmd, ["run", "build"], { cwd: webDir, stdio: "inherit", env: buildEnv });
if (build.status !== 0) {
  console.error("[build-web] web/ build failed");
  process.exit(build.status ?? 1);
}
console.log("[build-web] frontend built → public/");
