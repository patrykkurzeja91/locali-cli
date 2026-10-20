#!/usr/bin/env node
import { runCli } from './commands';

runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  fetch: globalThis.fetch,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
}).then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(3);
  }
);
