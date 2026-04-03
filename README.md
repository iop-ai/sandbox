# iop

Autonomous AI coding loop. Runs AI agents on tasks until done.

## Install

```bash
git clone https://github.com/iop-ai/sandbox.git
cd sandbox && chmod +x iop.sh

./iop.sh "add login button"
./iop.sh --prd PRD.md
```

## Two Modes

**Single task** - just tell it what to do:
```bash
iop "add dark mode"
iop "fix the auth bug"
```

**Task list** - work through a PRD:
```bash
iop              # uses PRD.md
iop --prd tasks.md
```

## Project Config

Optional. Stores rules the AI must follow.

```bash
iop --init              # auto-detects project settings
iop --config            # view config
iop --add-rule "use TypeScript strict mode"
```

Creates `.iop/config.yaml`:
```yaml
project:
  name: "my-app"
  language: "TypeScript"
  framework: "Next.js"

commands:
  test: "npm test"
  lint: "npm run lint"
  build: "npm run build"

rules:
  - "use server actions not API routes"
  - "follow error pattern in src/utils/errors.ts"

boundaries:
  never_touch:
    - "src/legacy/**"
    - "*.lock"
```

Rules apply to all tasks (single or PRD).

## AI Engines

```bash
iop              # Claude Code (default)
iop --codex      # Codex
```

### Model Override

Override the default model for any engine:

```bash
iop --model sonnet "add feature"                    # use sonnet with Claude
iop --sonnet "add feature"                          # shortcut for above
```

### Engine-Specific Arguments

Pass additional arguments to the underlying engine CLI using `--` separator:

```bash
# Pass claude-specific arguments
iop --claude "add feature" -- --no-permissions-prompt

# Works with any engine
iop --codex "fix bug" -- --custom-arg value
```

Everything after `--` is passed directly to the engine CLI without interpretation.

## Task Sources

**Markdown file** (default):
```bash
iop --prd PRD.md
```
```markdown
## Tasks
- [ ] create auth
- [ ] add dashboard
- [x] done task (skipped)
```

**Markdown folder** (for large projects):
```bash
iop --prd ./prd/
```
When pointing to a folder, iop reads all `.md` files and aggregates tasks:
```
prd/
  backend.md      # - [ ] create user API
  frontend.md     # - [ ] add login page
  infra.md        # - [ ] setup CI/CD
```
Tasks are tracked per-file so completion updates the correct file.

**YAML**:
```bash
iop --yaml tasks.yaml
```
```yaml
tasks:
  - title: create auth
    completed: false
  - title: add dashboard
    completed: false
```

**JSON**:
```bash
iop --json PRD.json
```
```json
{
  "tasks": [
    {
      "title": "create auth",
      "completed": false,
      "parallel_group": 1,
      "description": "Optional details"
    }
  ]
}
```
Titles must be unique.

**GitHub Issues**:
```bash
iop --github owner/repo
iop --github owner/repo --github-label "ready"
```

## Parallel Execution

```bash
iop --parallel                  # 3 agents default
iop --parallel --max-parallel 5 # 5 agents
```

Each agent gets isolated worktree + branch:
```
Agent 1 → /tmp/xxx/agent-1 → iop/agent-1-create-auth
Agent 2 → /tmp/xxx/agent-2 → iop/agent-2-add-dashboard
Agent 3 → /tmp/xxx/agent-3 → iop/agent-3-build-api
```

Without `--create-pr`: auto-merges back to base branch, AI resolves conflicts.
With `--create-pr`: keeps branches, creates PRs.
With `--no-merge`: keeps branches without merging or creating PRs.

**YAML parallel groups** - control execution order:
```yaml
tasks:
  - title: Create User model
    parallel_group: 1
  - title: Create Post model
    parallel_group: 1  # same group = runs together
  - title: Add relationships
    parallel_group: 2  # runs after group 1
```

## Branch Workflow

```bash
iop --branch-per-task                # branch per task
iop --branch-per-task --create-pr    # + create PRs
iop --branch-per-task --draft-pr     # + draft PRs
iop --base-branch main               # branch from main
```

Branch naming: `iop/<task-slug>`

## Webhook Notifications

Get notified when sessions complete via Discord, Slack, or custom webhooks.

**Config** (`.iop/config.yaml`):
```yaml
notifications:
  discord_webhook: "https://discord.com/api/webhooks/..."
  slack_webhook: "https://hooks.slack.com/services/..."
  custom_webhook: "https://your-api.com/webhook"
```

Notifications include task completion counts and status (completed/failed).

## Sandbox Droplet

Run iop inside an ephemeral DigitalOcean droplet:

```bash
./sandbox.sh git@github.com:user/repo.git   # Provision droplet + clone repo
ssh devbox                                    # SSH in

# Inside droplet:
cd projects/repo
iop "add dark mode toggle"            # Single task
iop --prd PRD.md                      # Batch tasks
iop --prd PRD.md --parallel           # Parallel with worktrees
```

The droplet self-destructs after 24 hours.

## Options

| Flag | What it does |
|------|--------------|
| `--prd PATH` | task file or folder (auto-detected, default: PRD.md) |
| `--yaml FILE` | YAML task file |
| `--json FILE` | JSON task file |
| `--github REPO` | use GitHub issues |
| `--github-label TAG` | filter issues by label |
| `--sync-issue N` | sync PRD progress to GitHub issue #N |
| `--model NAME` | override model for any engine |
| `--sonnet` | shortcut for `--claude --model sonnet` |
| `--parallel` | run parallel |
| `--max-parallel N` | max agents (default: 3) |
| `--no-merge` | skip auto-merge in parallel mode |
| `--branch-per-task` | branch per task |
| `--base-branch NAME` | base branch |
| `--create-pr` | create PRs |
| `--draft-pr` | draft PRs |
| `--no-tests` | skip tests |
| `--no-lint` | skip lint |
| `--fast` | skip tests + lint |
| `--no-commit` | don't auto-commit |
| `--max-iterations N` | stop after N tasks |
| `--max-retries N` | retries per task (default: 3) |
| `--retry-delay N` | seconds between retries |
| `--dry-run` | preview only |
| `-v, --verbose` | debug output |
| `--init` | setup .iop/ config |
| `--config` | show config |
| `--add-rule "rule"` | add rule to config |

## Requirements

**Required:**
- AI CLI: [Claude Code](https://github.com/anthropics/claude-code) or Codex
- Node.js 18+ or Bun

**Optional:**
- `jq` (for bash script)
- `yq` (for YAML tasks)
- `gh` (for GitHub issues / `--create-pr`)

## Engine Details

| Engine | CLI | Permissions | Output |
|--------|-----|-------------|--------|
| Claude | `claude` | `--dangerously-skip-permissions` | tokens + cost |
| Codex | `codex` | N/A | tokens |

When an engine exits non-zero, iop includes the last lines of CLI output in the error message to make debugging easier.

## Contributing

**Key principles:**
- Keep changes small and focused - one logical change per commit
- Break large tasks into micro-tasks
- Quality over speed
- Don't leave dead code
- Fight entropy - leave the codebase better than you found it

AI coding assistants can reference:
- [CLAUDE.md](CLAUDE.md) - Claude Code instructions

## License

MIT
