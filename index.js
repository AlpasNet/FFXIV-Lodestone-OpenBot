require("dotenv").config();

const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const cheerio = require("cheerio");
const fs = require("fs");

const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHECK_INTERVAL_MINUTES = Number(process.env.CHECK_INTERVAL_MINUTES || 10);

const SEEN_FILE = "./seen-news.json";

const CATEGORIES = [
  {
    key: "topics",
    label: "Topics",
    url: "https://eu.finalfantasyxiv.com/lodestone/topics/",
    channelId: process.env.CHANNEL_TOPICS,
    color: 0xf1c40f,
    emoji: "⭐"
  },
  {
    key: "notices",
    label: "Notices",
    url: "https://eu.finalfantasyxiv.com/lodestone/news/category/1",
    channelId: process.env.CHANNEL_NOTICES,
    color: 0x3498db,
    emoji: "ℹ️"
  },
  {
    key: "maintenance",
    label: "Maintenance",
    url: "https://eu.finalfantasyxiv.com/lodestone/news/category/2",
    channelId: process.env.CHANNEL_MAINTENANCE,
    color: 0xe67e22,
    emoji: "🛠️"
  },
  {
    key: "updates",
    label: "Updates",
    url: "https://eu.finalfantasyxiv.com/lodestone/news/category/3",
    channelId: process.env.CHANNEL_UPDATES,
    color: 0x2ecc71,
    emoji: "🔄"
  }
];

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

function checkEnv() {
  if (!DISCORD_TOKEN) {
    console.error("Error: DISCORD_TOKEN is missing in the .env file");
    process.exit(1);
  }

  const missingChannels = CATEGORIES.filter(category => !category.channelId);

  if (missingChannels.length > 0) {
    console.warn("Warning: some channels are not configured:");
    missingChannels.forEach(category => {
      console.warn(`- ${category.label}`);
    });
  }
}

function loadSeenNews() {
  if (!fs.existsSync(SEEN_FILE)) {
    fs.writeFileSync(SEEN_FILE, JSON.stringify({}));
  }

  try {
    return JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveSeenNews(seen) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));
}

function absoluteUrl(url, baseUrl) {
  if (!url) return null;
  if (url.startsWith("http")) return url;
  return new URL(url, baseUrl).href;
}

function cleanText(text) {
  if (!text) return "";
  return text.replace(/\s+/g, " ").trim();
}

function limitText(text, maxLength = 500) {
  if (!text) return null;
  const cleaned = cleanText(text);

  if (cleaned.length <= maxLength) {
    return cleaned;
  }

  return cleaned.slice(0, maxLength - 3) + "...";
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 FFXIV Lodestone Discord Bot"
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP error ${response.status} on ${url}`);
  }

  return await response.text();
}

async function fetchArticleDetails(articleUrl) {
  try {
    const html = await fetchHtml(articleUrl);
    const $ = cheerio.load(html);

    const ogImage =
      $("meta[property='og:image']").attr("content") ||
      $("meta[name='twitter:image']").attr("content");

    const firstImage =
      $(".news__detail__wrapper img").first().attr("src") ||
      $(".news__detail img").first().attr("src") ||
      $(".topics__detail img").first().attr("src") ||
      $("article img").first().attr("src") ||
      $("main img").first().attr("src");

    const ogDescription =
      $("meta[property='og:description']").attr("content") ||
      $("meta[name='description']").attr("content") ||
      $("meta[name='twitter:description']").attr("content");

    let description = ogDescription ? cleanText(ogDescription) : null;

    if (!description) {
      description =
        cleanText($(".news__detail__wrapper").first().text()) ||
        cleanText($(".news__detail").first().text()) ||
        cleanText($(".topics__detail").first().text()) ||
        cleanText($("article").first().text()) ||
        null;
    }

    return {
      image: ogImage
        ? absoluteUrl(ogImage, articleUrl)
        : firstImage
          ? absoluteUrl(firstImage, articleUrl)
          : null,

      description: limitText(description, 500)
    };
  } catch (error) {
    console.error(`Unable to fetch article details: ${articleUrl}`);
    return {
      image: null,
      description: null
    };
  }
}

async function fetchCategoryNews(category) {
  const html = await fetchHtml(category.url);
  const $ = cheerio.load(html);

  const news = [];

  $("a").each((_, element) => {
    const link = $(element);
    const href = link.attr("href");
    const title = cleanText(link.text());

    if (!href || !title) return;

    const fullUrl = absoluteUrl(href, category.url);

    const isArticle =
      fullUrl.includes("/lodestone/news/detail/") ||
      fullUrl.includes("/lodestone/topics/detail/");

    if (!isArticle) return;
    if (title.length < 6) return;

    const listImage =
      link.find("img").first().attr("src") ||
      link.closest("li").find("img").first().attr("src") ||
      link.closest("article").find("img").first().attr("src") ||
      link.closest("div").find("img").first().attr("src");

    news.push({
      id: fullUrl,
      title,
      url: fullUrl,
      image: listImage ? absoluteUrl(listImage, category.url) : null,
      description: null,
      categoryKey: category.key,
      categoryLabel: category.label,
      color: category.color,
      emoji: category.emoji
    });
  });

  const uniqueNews = Array.from(
    new Map(news.map(item => [item.id, item])).values()
  );

  return uniqueNews.slice(0, 10);
}

async function postNews(item, channelId) {
  const channel = await client.channels.fetch(channelId);

  if (!channel) {
    console.error(`Channel not found: ${channelId}`);
    return;
  }

  const details = await fetchArticleDetails(item.url);

  if (!item.image && details.image) {
    item.image = details.image;
  }

  if (!item.description && details.description) {
    item.description = details.description;
  }

  const embed = new EmbedBuilder()
    .setAuthor({
      name: `The Lodestone - ${item.categoryLabel}`
    })
    .setTitle(`${item.emoji} ${item.title}`)
    .setURL(item.url)
    .setDescription(item.description || "New Lodestone publication available.")
    .addFields({
      name: "Link",
      value: `[Open the article on The Lodestone](${item.url})`
    })
    .setColor(item.color)
    .setFooter({
      text: "FINAL FANTASY XIV - The Lodestone"
    })
    .setTimestamp(new Date());

  if (item.image) {
    embed.setImage(item.image);
  }

  await channel.send({ embeds: [embed] });
}

async function checkCategory(category, seen, firstRun = false) {
  if (!category.channelId) {
    console.log(`Category ignored, channel not configured: ${category.label}`);
    return;
  }

  console.log(`Checking: ${category.label}`);

  const currentNews = await fetchCategoryNews(category);

  if (!seen[category.key]) {
    seen[category.key] = [];
  }

  if (firstRun) {
    seen[category.key] = currentNews.map(item => item.id);
    console.log(
      `Initial setup ${category.label}: ${currentNews.length} publication(s) saved without posting.`
    );
    return;
  }

  const newItems = currentNews.filter(
    item => !seen[category.key].includes(item.id)
  );

  if (newItems.length === 0) {
    console.log(`No new publication for ${category.label}.`);
    return;
  }

  const orderedItems = newItems.reverse();

  for (const item of orderedItems) {
    await postNews(item, category.channelId);
    seen[category.key].push(item.id);
  }

  seen[category.key] = [...new Set(seen[category.key])].slice(-200);

  console.log(
    `${newItems.length} new publication(s) sent for ${category.label}.`
  );
}

async function checkAllCategories(firstRun = false) {
  const seen = loadSeenNews();

  for (const category of CATEGORIES) {
    try {
      await checkCategory(category, seen, firstRun);
    } catch (error) {
      console.error(`Category error ${category.label}:`, error.message);
    }
  }

  saveSeenNews(seen);
}

client.once("ready", async () => {
  console.log(`Bot connected as ${client.user.tag}`);

  const seen = loadSeenNews();
  const isFirstRun = Object.keys(seen).length === 0;

  await checkAllCategories(isFirstRun);

  setInterval(() => {
    checkAllCategories(false).catch(error => {
      console.error("Global check error:", error);
    });
  }, CHECK_INTERVAL_MINUTES * 60 * 1000);
});

checkEnv();
client.login(DISCORD_TOKEN);
