#!/bin/sh

pm2 start index.js --name "ffxiv-lodestone-openbot"
pm2 save
