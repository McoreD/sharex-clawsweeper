#!/usr/bin/env node
/**
 * ShareX-optimized, read-only ClawSweeper runner using OpenClaw (no OpenAI required).
 *
 * Usage:
 *   node scripts/sharex-sweep.mjs --items 8260,1121 [--model minimax/MiniMax-M3]
 *     [--sharex-repo /home/mike/Work/ShareX/ShareX]
 *     [--mc-repo /home/mike/Work/ShareX/mission-control]
 *     [--artifact-dir artifacts/sharex/2026-11-21]
 *     [--dry-run]
 *
 * Safety guarantees:
 *   - Always passes --target-repo ShareX/ShareX --skip-start-comment --local-only.
 *   - Wraps `gh` with a read-only shim that permits GET requests only (blocks comment/close/edit/pr/POST).
 *   - Runs OpenClaw with CLAWSWEEPER_OPENCLAW_READONLY=1 (no shell exec, workspace-only reads).
 *   - Checks out ShareX/ShareX origin/develop into a temporary clean worktree so your local checkout stays untouched.
 *   - Injects ShareX/mission-control's sharex-humanizer skill rules so closeComment reads like McoreD typed it.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  const opts = {
    items: "",
    model: process.env.CLAWSWEEPER_OPENCLAW_MODEL || "minimax/MiniMax-M3",
    sharexRepo: "/home/mike/Work/ShareX/ShareX",
    mcRepo: "/home/mike/Work/ShareX/mission-control",
    artifactDir: "",
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--items") opts.items = argv[++i] || "";
    else if (arg === "--model") opts.model = argv[++i] || opts.model;
    else if (arg === "--sharex-repo") opts.sharexRepo = argv[++i] || opts.sharexRepo;
    else if (arg === "--mc-repo") opts.mcRepo = argv[++i] || opts.mcRepo;
    else if (arg === "--artifact-dir") opts.artifactDir = argv[++i] || "";
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node scripts/sharex-sweep.mjs --items 8260,1121 [--model minimax/MiniMax-M3] [--artifact-dir DIR] [--dry-run]",
      );
      process.exit(0);
    }
  }
  if (!opts.items.trim()) {
    console.error("error: --items <comma-separated issue numbers> is required");
    process.exit(2);
  }
  return opts;
}

function findRealGh() {
  const res = spawnSync("which", ["gh"], { encoding: "utf8" });
  if (res.status !== 0 || !res.stdout.trim()) {
    throw new Error("gh CLI not found on PATH");
  }
  return res.stdout.trim();
}

function createReadOnlyGhShim(dir, realGh) {
  const shimPath = join(dir, "gh");
  const script = `#!/usr/bin/env bash
set -euo pipefail
# Defense-in-depth read-only GitHub shim for ShareX ClawSweeper runs.
REAL_GH=${JSON.stringify(realGh)}
cmd="\${1:-}"
sub="\${2:-}"
if [[ "$cmd" == "api" ]]; then
  for arg in "$@"; do
    case "$arg" in
      POST|PUT|PATCH|DELETE|--method=POST|--method=PUT|--method=PATCH|--method=DELETE|-XPOST|-XPUT|-XPATCH|-XDELETE|-f|-F|--field|--raw-field|--input)
        echo "BLOCKED by read-only ShareX shim: gh $*" >&2
        exit 99
        ;;
    esac
  done
  exec "$REAL_GH" "$@"
fi
if [[ "$cmd" == "issue" && ( "$sub" == "view" || "$sub" == "list" ) ]] || \
   [[ "$cmd" == "pr" && ( "$sub" == "view" || "$sub" == "list" ) ]] || \
   [[ "$cmd" == "repo" && "$sub" == "view" ]] || \
   [[ "$cmd" == "auth" && "$sub" == "status" ]]; then
  exec "$REAL_GH" "$@"
fi
echo "BLOCKED by read-only ShareX shim: gh $*" >&2
exit 99
`;
  writeFileSync(shimPath, script, { encoding: "utf8", mode: 0o755 });
  chmodSync(shimPath, 0o755);
  return shimPath;
}

function buildShareXPrompt(mcRepo) {
  const humanizerPath = join(mcRepo, ".agents", "skills", "sharex-humanizer", "SKILL.md");
  const humanizer = existsSync(humanizerPath) ? readFileSync(humanizerPath, "utf8") : "";
  return [
    "ShareX-specific review rules:",
    "- Target branch is ShareX/ShareX develop (not main).",
    "- Distinguish UI era: ShareX <= 21.x is Windows Forms / GDI+ (Windows-only); ShareX >= 22.0 is the Avalonia UI rewrite (ShareX.Avalonia, ShareX.ImageEditor, ShareX.ScreenRecordingLib, ShareX.Platform.*).",
    "- For legacy WinForms/GDI+ issues that cannot be reproduced on Avalonia v22, keep open as needs-info (reproductionStatus: unclear) asking whether it still happens on 22.4+, or mark stale_version_bug only with direct code proof.",
    "- Never mention OpenClaw, ClawHub, AI tools, or crustacean jokes. Draft closeComment as if McoreD typed it personally.",
    "- Never say or imply that ShareX is dropping, declining, or compromising Windows features due to cross-platform support or Avalonia.",
    humanizer ? `\nFollow these writing rules strictly for closeComment:\n\n${humanizer}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const today = new Date().toISOString().slice(0, 10);
  const artifactDir = resolve(opts.artifactDir || join(ROOT, "artifacts", "sharex", today));
  const distCli = join(ROOT, "dist", "clawsweeper.js");
  if (!existsSync(distCli)) {
    console.error("error: dist/clawsweeper.js not built yet. Run pnpm run build:node first.");
    process.exit(1);
  }
  const realGh = findRealGh();
  const sandboxTmp = mkdtempSync(join(tmpdir(), "sharex-clawsweeper-"));
  const shimDir = join(sandboxTmp, "bin");
  const cleanCheckout = join(sandboxTmp, "sharex-develop");
  mkdirSync(shimDir, { recursive: true });
  mkdirSync(artifactDir, { recursive: true });
  createReadOnlyGhShim(shimDir, realGh);

  try {
    const promptText = buildShareXPrompt(opts.mcRepo);
    const args = [
      distCli,
      "review",
      "--target-repo",
      "ShareX/ShareX",
      "--item-numbers",
      opts.items,
      "--openclaw-dir",
      cleanCheckout,
      "--artifact-dir",
      artifactDir,
      "--skip-start-comment",
      "--local-only",
      "--additional-prompt",
      promptText,
    ];
    if (opts.dryRun) {
      console.log(
        JSON.stringify(
          {
            runner: "openclaw",
            model: opts.model,
            readonly: true,
            items: opts.items.split(",").map((s) => Number(s.trim())),
            artifactDir,
            sharexRepo: opts.sharexRepo,
            command: ["node", ...args.slice(0, -2), "--additional-prompt", "<sharex-humanizer>"],
          },
          null,
          2,
        ),
      );
      return;
    }

    // Export a clean detached copy of origin/develop without touching Mike's working tree.
    const exportCmd = spawnSync(
      "git",
      ["-C", opts.sharexRepo, "worktree", "add", "--detach", cleanCheckout, "origin/develop"],
      { encoding: "utf8" },
    );
    if (exportCmd.status !== 0) {
      throw new Error(`Failed to prepare clean ShareX develop worktree: ${exportCmd.stderr}`);
    }

    const env = {
      ...process.env,
      PATH: `${shimDir}:${process.env.PATH || ""}`,
      CLAWSWEEPER_RUNNER: "openclaw",
      CLAWSWEEPER_OPENCLAW_MODEL: opts.model,
      CLAWSWEEPER_OPENCLAW_READONLY: "1",
    };
    delete env.OPENAI_API_KEY;

    const run = spawnSync(process.execPath, args, { cwd: ROOT, env, stdio: "inherit" });
    process.exitCode = run.status ?? 1;
  } finally {
    if (existsSync(cleanCheckout)) {
      spawnSync("git", ["-C", opts.sharexRepo, "worktree", "remove", "--force", cleanCheckout], {
        stdio: "ignore",
      });
    }
    rmSync(sandboxTmp, { recursive: true, force: true });
  }
}

main();
