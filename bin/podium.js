#!/usr/bin/env node
import { main } from '../engine/cli.js';

process.exitCode = await main(process.argv.slice(2));
