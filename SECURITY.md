# Security Policy

Coxpit runs agent fleets and **exposes shells and a code editor**. A misconfigured
or vulnerable daemon is a serious foothold — so security reports get priority.

## Supported versions

Coxpit ships from a single line of development. Only the **latest release** on npm
/ GitHub Releases is supported; please reproduce on the latest before reporting.

## Reporting a vulnerability

**Please do not open a public issue, PR, or discussion for a security problem.**

Report it privately through GitHub:

1. Go to the repository's **Security** tab →
   [**Report a vulnerability**](https://github.com/hanmariyang/coxpit-oss/security/advisories/new).
2. Describe the issue, the impact, and a minimal repro. Include the coxpit version
   and how the daemon was exposed (local, LAN, Tailscale Serve/Funnel, Cloudflare,
   reverse proxy).

You'll get an acknowledgement as soon as possible. Once a fix is ready we'll
coordinate a release and credit you in the advisory (unless you prefer to stay
anonymous).

## Scope & hardening notes

Coxpit is **self-hosted and owner-first** — you run the daemon, and how you expose
it is your access layer. A few things that are *expected behavior*, not bugs:

- **Exposing the daemon exposes shells.** Front it with your own auth (Tailscale,
  Cloudflare Access, a reverse proxy + TLS) and keep basic auth on. `COXPIT_AUTH_*`
  is **fail-closed** — an empty password (without `COXPIT_AUTH_DISABLED=1`) rejects
  every request.
- **Tailscale Funnel is public.** It's behind an explicit toggle and a warning
  precisely because it puts shells on the internet — basic auth is then the only
  gate. Serve (tailnet-only) is the safe default.
- **Agents run with your CLI's own credentials** on your machine. Coxpit stores no
  keys; it drives the CLI you signed into.

Genuine issues — auth bypass, sandbox/worktree escape, SSRF, injection into the
spawn/merge path, secret leakage — are exactly what we want to hear about.
