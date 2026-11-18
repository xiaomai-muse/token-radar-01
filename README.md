# token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/xiaomai-muse/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/xiaomai-muse/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar: ranks 198 pre-token protocols by implied value, with a concrete farm plan for each, from a sealed DefiLlama snapshot (758 protocols, 40-protocol watchlist). Implied values are calibrated from 119 live-token peers' MCAP/TVL multiples in the same snapshot — no hardcoded names, no hardcoded list.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /input/snapshot.json
```

Reads the competition snapshot, writes the ranked board (`board.json`), the dashboard data (`data.js`), copies `dashboard/` and `screenshots/` to the output directory, and writes `dossier.json`. Node 22+, standard library only, no network. Run it twice and the outputs are byte-identical.

---

<sub>Entered on [make.fun](https://make.fun/?ref=8vjkry41&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
