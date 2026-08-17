# Coxpit

**Owner-first web cockpit to run and steer a fleet of AI coding agents across your own machines, from any device.**

Run multiple coding agents in parallel, each in its own isolated git worktree, on your Mac mini, laptop, or a VPS. Compare their diffs, pick the winner, and steer them from your phone. Self-hosted, behind your own auth. Your code never leaves your network.

> Not a merger of other tools. A single thesis: **you own it, from anywhere, across your machines.**

## Status

`v2.0-p1` — early. P1 = the agent fleet (parallel worktree runs + live board). See `Docs/` for the design.

## Quickstart (dev)

```bash
npm install
cp .env.example .env      # set COXPIT_AUTH_PASS, or COXPIT_AUTH_DISABLED=1 for local
npm run dev               # daemon on http://127.0.0.1:8210
curl http://127.0.0.1:8210/api/health
```

## Stack

- **Daemon**: Node/TS (Fastify + WebSocket), SQLite (Drizzle).
- **Agents**: spawned CLI agents (Claude Code first), each in a git worktree + tmux window.
- **Remote machines**: over SSH (Tailscale/LAN).
- **UI**: web dashboard (added in a later step).

External tools are spawned, not vendored: `tmux`, agent CLIs. No editor bundled (terminal-first).

## License

MIT.
