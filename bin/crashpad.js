#!/usr/bin/env node
// Runs the compiled CLI (built by `npm install`/`npm run build`).
import { main } from "../dist/cli.js";

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`crashpad: ${err?.stack ?? err}\n`);
    process.exit(2);
  },
);
