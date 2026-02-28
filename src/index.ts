#!/usr/bin/env node

import { program } from './cli/index.js';

program.parse(process.argv);

// If no command specified, show help
if (!process.argv.slice(2).length) {
    program.outputHelp();
}
