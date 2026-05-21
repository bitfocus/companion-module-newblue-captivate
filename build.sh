#!/bin/bash

~/.nvm/nvm.sh use 18
yarn package

date=$(date '+%Y-%m-%d')
version=$(cat companion/manifest.json | jq -r .version)

TARGET=out
mkdir -p $TARGET

# clear previous builds
rm -rf $TARGET/pkg/
rm -rf $TARGET/companion-module-newblue-captivate/
rm -f $TARGET/companion-module-newblue-captivate*.zip

# extract new build
tar -xf pkg.tgz

# rename extracted folder
mv pkg $TARGET/companion-module-newblue-captivate

# zip the build
pushd $TARGET
zip -r companion-module-newblue-captivate--$date--$version.zip companion-module-newblue-captivate/*
popd

echo "Build completed: $TARGET/companion-module-newblue-captivate--$date--$version.zip"
