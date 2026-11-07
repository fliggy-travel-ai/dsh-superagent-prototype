#!/bin/zsh
# 隔离守护进程专用：干净环境 + 临时 PASEO_HOME。用法：cli.sh [--with-token] <paseo 参数...>
extra=()
if [[ "$1" == "--with-token" ]]; then extra=(GH_TOKEN="$GH_TOKEN"); shift; fi
exec env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/bin:/opt/homebrew/bin" USER="$USER" TMPDIR="$TMPDIR" LANG=en_US.UTF-8 PASEO_HOME=/tmp/m0/home $extra /Applications/Paseo.app/Contents/Resources/bin/paseo "$@" --home /tmp/m0/home
