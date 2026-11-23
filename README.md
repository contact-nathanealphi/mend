# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/contact-nathanealphi/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/contact-nathanealphi/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend — one patch tool for every AI edit format. It reads a patch in any of
four formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits), finds
the lines each edit names at the first of three matching tiers (exact,
whitespace-normalised, whitespace-insensitive with re-indentation), and
writes every change or none. Node 22, standard library only, deterministic.

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is a patch file; with no argument the patch is read from stdin.
Options: `--strict` (exact matching only), `--dry-run` (resolve without
writing), `--help`, `--version`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=7053etrm&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
