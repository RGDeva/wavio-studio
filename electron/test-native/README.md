# Test-native better-sqlite3 (Node-ABI, test-only)

The desktop app links `better-sqlite3` built for **Electron's ABI** (Electron 31,
`NODE_MODULE_VERSION` 125). The Vitest suites run under plain **Node**, which has
a **different ABI** (Node 22 → 127). A single `better-sqlite3` binary cannot
satisfy both at once, so loading the root (Electron-ABI) copy from Node fails
with `ERR_DLOPEN_FAILED`.

This fixture is an **isolated, Node-ABI** install of the *same* `better-sqlite3`
version (`11.9.1`) the app uses. It is resolved only by
`electron/test-helpers/native-sqlite.ts`. The root `node_modules/better-sqlite3`
(Electron-ABI) is **never rebuilt or overwritten** — the two coexist.

## Local setup

```bash
nvm use            # Node 22, per .nvmrc / .node-version
npm run test:setup-native   # installs this fixture's node_modules (Node-ABI prebuild)
npm test           # runs vitest under Node 22
```

`node_modules/` here is gitignored; `package-lock.json` is committed so the
install is reproducible. On an unsupported Node, `npm test`'s pretest check
fails clearly and the `native-sqlite.guard` test turns a missing/unloadable
module into a hard failure (never a silent skip).
