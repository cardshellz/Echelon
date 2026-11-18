#!/usr/bin/env bash
set -euo pipefail

export NODE_ENV=production

# The old-space limit alone leaves V8 free to reserve a large young generation.
# On the 512 MiB web dyno, the default produced a 576 MiB total heap limit and
# a 128 MiB young space. Bound both generations while retaining the existing
# old-space limit. Heroku invokes this script directly; exec replaces its shell
# with Node, so the web dyno does not keep an npm launcher in memory.
exec node --max-old-space-size=384 --max-semi-space-size=16 dist/index.cjs
