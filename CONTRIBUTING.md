# Contributing

**This repository is generated. Do not send pull requests here.**

It is a one-way mirror of `template/mcp-entra/` in
[BentleySystems/AI-Enablement-MyPage](https://github.com/BentleySystems/AI-Enablement-MyPage),
republished by that repo's `sync-template` workflow on every change. Anything
committed directly here is overwritten by the next sync.

## Why it is mirrored rather than maintained here

The auth layer in `src/auth/` is extracted from a server that runs in
production against a real Entra tenant. Keeping the two in one repository is
what lets a check (`npm run check:template`) fail when they diverge — the
template has already, once, shipped an authorization model the product had
deliberately replaced. Split them and nothing notices again.

## Where to send a change

Open a pull request against `template/mcp-entra/` in the upstream repository,
and read its `AGENTS.md` first: files under `src/auth/` are either mirrored
byte-for-byte from the production server or recorded as deliberate
divergences, and the check enforces which is which.

## Using this template

Press **Use this template**, then follow the customisation checklist in
[README.md](README.md). Nothing here belongs to any one Bentley product; the
Bentley-wide values it ships with, such as the shared DNS zone, are the same for
every team that uses it.
