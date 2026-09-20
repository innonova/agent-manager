#!/usr/bin/env bash
# Seeding of the manager's operator files (the harness note, the models
# file, the method), sourced by install-user-service.sh and by its test.
#
#   seed_config_file <what> <shipped file> <target> <install dir>
#
# The config copy is what runs; the shipped text goes there when there is
# no copy, or when the copy is still the text the previous install shipped
# (unchanged by the operator: the previously shipped text is the one in the
# install directory, which the caller reads before replacing it). An edited
# copy is kept and pointed out.
seed_config_file() {
  local what="$1" src="$2" target="$3" install_dir="${4:-}"
  local previous="$install_dir/$(basename "$src")"
  if [ ! -e "$target" ]; then
    mkdir -p "$(dirname "$target")"
    cp "$src" "$target"
    echo "$what seeded at $target"
  elif cmp -s "$src" "$target"; then
    : # already the shipped text
  elif [ -n "$install_dir" ] && [ -e "$previous" ] && cmp -s "$previous" "$target"; then
    cp "$src" "$target"
    echo "$what updated at $target (it was the previously shipped text, unchanged)"
  else
    echo "$what at $target is edited; kept (the UI shows the shipped text too)"
  fi
}
