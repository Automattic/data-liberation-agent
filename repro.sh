#!/usr/bin/env bash
set -euo pipefail
# Both pagination fixtures are maintained in the existing assembly browser test.
npx vitest run src/lib/responsive-assembly.test.ts -t 'projects viewport-dependent pagination classes'
