#!/bin/bash

~/.nvm/nvm.sh use 18

node ./bump-verion.js
./build.sh
