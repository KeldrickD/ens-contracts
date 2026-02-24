## Cursor Cloud specific instructions

This is the **ENS Contracts** repository (`@ensdomains/ens-contracts`) — Solidity smart contracts for the Ethereum Name Service.

### Prerequisites

- **Node.js v24.6.0** (per `.nvmrc` / Volta config)
- **Bun** (package manager — `bun.lock` is the lockfile)

### Key Commands

See `package.json` scripts. The most common:

| Task | Command |
|---|---|
| Install deps | `bun install` |
| Compile contracts | `bun run compile` |
| Run tests | `bun run test` |
| Build (compile + tsc) | `bun run build` |
| Format (prettier) | `bun run format` |
| Lint (prettier check) | `npx prettier --check .` |

### Gotchas

- **`bun run lint` is broken**: The lint script calls `bun run hh check`, but `hh` (hardhat-shorthand) is not installed and `check` is not a valid Hardhat v3 task. Use `npx prettier --check .` instead to verify formatting.
- **No external services needed**: Tests run against Hardhat's built-in EDR (Ethereum Development Runtime) simulated network. No database, Docker, or API keys are required for local testing.
- **Compilation warnings are expected**: The `NameWrapper.sol` contract produces shadowed-declaration warnings during compilation — these are benign.
- **Pre-commit hook**: `.husky/pre-commit` runs `bun run format` (Prettier) on commit.
- **Node version**: Must use Node v24.6.0. The environment uses `nvm` to manage this. Run `source ~/.nvm/nvm.sh && nvm use` before commands if needed.
