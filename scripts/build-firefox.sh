#!/bin/sh
# Packages the Firefox add-on: extension/manifest.json, its icons and the userscript itself
# (the add-on runs the same file). Output: dist/emotekit-firefox-<version>.zip
set -eu
cd "$(dirname "$0")/.."

version=$(sed -n 's|^// @version *||p' emotekit.user.js)
manifest_version=$(sed -n 's|^ *"version": "\(.*\)",|\1|p' extension/manifest.json)
if [ "$version" != "$manifest_version" ]; then
  echo "Version mismatch: emotekit.user.js is $version, extension/manifest.json is $manifest_version" >&2
  exit 1
fi

out="dist/emotekit-firefox-$version.zip"
stage="dist/firefox"
rm -rf "$stage" "$out"
mkdir -p "$stage/icons"
cp extension/manifest.json "$stage/"
cp extension/icons/*.png "$stage/icons/"
cp emotekit.user.js "$stage/"
(cd "$stage" && zip -q -X -r "../$(basename "$out")" manifest.json emotekit.user.js icons)
echo "$out"
