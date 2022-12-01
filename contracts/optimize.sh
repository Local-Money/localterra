#! /bin/bash
set -e

docker run --rm -v "$(pwd)":/code \
  --mount type=volume,source="$(basename "$(pwd)")_cache",target=/code/target \
  --mount type=volume,source=registry_cache,target=/usr/local/cargo/registry \
  cosmwasm/rust-optimizer:0.12.9

# ARM
#docker run --rm -v "$(pwd)":/code \
#  --mount type=volume,source="$(basename "$(pwd)")_cache",target=/code/target \
#  --mount type=volume,source=registry_cache,target=/usr/local/cargo/registry \
#  cosmwasm/workspace-optimizer-arm64:0.12.8
