# Tests

Lightweight Node-native test suite. No extra test-runner dependency — we use
Node 20's built-in `node --test` and plain `.test.mjs` files.

The tests exercise the **compiled output** under `dist/`, so they double as a
smoke test of the build pipeline.

```powershell
pnpm build
pnpm test
```

CI runs the same two commands on every push / PR, on both Ubuntu and Windows.
