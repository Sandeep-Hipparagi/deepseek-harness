#!/usr/bin/env node
import { Context } from 'cordis';
import a3hPlugin, { runCli } from '../dist/index.js';

const ctx = new Context();
ctx.plugin(a3hPlugin);

await ctx.start();

await runCli(ctx, process.argv.slice(2));
process.exit(0);
