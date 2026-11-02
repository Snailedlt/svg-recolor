#!/usr/bin/env bash
# Builds svgshift-linux.exe from the submodule as a fully static binary, so it
# runs on any x86-64 Linux regardless of the host's glibc version (Vercel's
# runtimes differ: Amazon Linux 2 has glibc 2.26, Amazon Linux 2023 has 2.34).
set -euo pipefail
cd "$(dirname "$0")/.."
gcc -O2 -static -s -o svgshift-linux.exe submodules/svgshift/svgshift.c
chmod +x svgshift-linux.exe
file svgshift-linux.exe
