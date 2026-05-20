#!/bin/sh

sudo apt-get update
sudo apt-get upgrade
sudo apt install nodejs npm
npm init -y
npm install discord.js cheerio node-fetch dotenv
pm2 start index.js --name "ffxiv-lodestone-openbot"
pm2 save
