require("dotenv").config();

const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const cheerio = require("cheerio");
const fs = require("fs");
const he = require("he");

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

  return he
    .decode(String(text))
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/\r/g, "")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanTitle(text) {
  return cleanText(text)
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function limitText(text, maxLength = 900) {
  if (!text) return null;

  const cleaned = cleanText(text);
  if (!cleaned) return null;

  if (cleaned.length <= maxLength) {
    return cleaned;
  }

  return cleaned.slice(0, maxLength - 3) + "...";
}

function cleanLodestoneDescription(text) {
  if (!text) return null;

  let description = cleanText(text);

  description = description
    .replace(/The Lodestone\s*\|?\s*FINAL FANTASY XIV.*$/i, "")
    .replace(/FINAL FANTASY XIV, The Lodestone.*$/i, "")
    .replace(/Official community site.*$/i, "")
    .replace(/JavaScript.*$/i, "")
    .replace(/window\..*$/i, "")
    .replace(/var .*$/i, "")
    .replace(/function\s*\(.*$/i, "")
    .replace(/Please enable JavaScript.*$/i, "")
    .trim();

  if (!description || description.length < 10) {
    return null;
  }

  return limitText(description, 500);
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

function getArticleText($) {
  $("script").remove();
  $("style").remove();
  $("noscript").remove();

  const selectors = [
    ".news__detail__wrapper",
    ".news__detail",
    ".topics__detail",
    ".ldst__window__body",
    ".ldst__window",
    "article",
    "main"
  ];

  for (const selector of selectors) {
    const element = $(selector).first();

    if (element.length) {
      const text = cleanText(element.html() || element.text());

      if (text && text.length > 20) {
        return text;
      }
    }
  }

  return null;
}

function extractFirstParagraph(text) {
  if (!text) return null;

  const cleaned = cleanText(text);

  const blockedStarts = [
    "News",
    "Topics",
    "Notices",
    "Maintenance",
    "Updates",
    "Status",
    "Patch Notes",
    "Special Sites",
    "The Lodestone",
    "FINAL FANTASY XIV"
  ];

  const paragraphs = cleaned
    .split(/\n{2,}|\n/)
    .map(p => p.trim())
    .filter(p => p.length >= 40)
    .filter(p => !blockedStarts.some(start => p.startsWith(start)))
    .filter(p => !p.includes("JavaScript"))
    .filter(p => !p.includes("window."))
    .filter(p => !p.includes("var "));

  if (paragraphs.length === 0) {
    return null;
  }

  return limitText(paragraphs[0], 900);
}

function extractDateTimeSection(text) {
  if (!text) return null;

  const cleaned = cleanText(text);
  const marker = "[Date & Time]";
  const startIndex = cleaned.indexOf(marker);

  if (startIndex === -1) {
    return null;
  }

  let afterMarker = cleaned.slice(startIndex + marker.length).trim();

  const stopMarkers = [
    "[Affected Service]",
    "[Affected Worlds]",
    "[Details]",
    "[Update Details]",
    "[Maintenance Details]",
    "[Recovery Details]",
    "[Issue Details]",
    "[Cause]",
    "[Countermeasures]",
    "[In-game Content]",
    "[Companion App]",
    "[Known Issues]"
  ];

  let stopIndex = -1;

  for (const stopMarker of stopMarkers) {
    const index = afterMarker.indexOf(stopMarker);

    if (index !== -1 && (stopIndex === -1 || index < stopIndex)) {
      stopIndex = index;
    }
  }

  if (stopIndex !== -1) {
    afterMarker = afterMarker.slice(0, stopIndex).trim();
  }

  const monthRegex =
    /\b(?:Jan\.?|January|Feb\.?|February|Mar\.?|March|Apr\.?|April|May|Jun\.?|June|Jul\.?|July|Aug\.?|August|Sep\.?|Sept\.?|September|Oct\.?|October|Nov\.?|November|Dec\.?|December)\b/i;

  const yearRegex = /\b20\d{2}\b/;

  const dateLines = afterMarker
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .filter(line => monthRegex.test(line) && yearRegex.test(line));

  if (dateLines.length === 0) {
    return null;
  }

  return limitText(dateLines.join("\n"), 1000);
}

async function fetchArticleDetails(articleUrl, categoryKey) {
  try {
    const html = await fetchHtml(articleUrl);
    const $ = cheerio.load(html);

    $("script").remove();
    $("style").remove();
    $("noscript").remove();

    const metaTitle =
      $("meta[property='og:title']").attr("content") ||
      $("meta[name='twitter:title']").attr("content") ||
      $("title").text();

    const metaDescription =
      $("meta[property='og:description']").attr("content") ||
      $("meta[name='description']").attr("content") ||
      $("meta[name='twitter:description']").attr("content");

    const metaImage =
      $("meta[property='og:image']").attr("content") ||
      $("meta[name='twitter:image']").attr("content");

    const fallbackImage =
      $(".news__detail__wrapper img").first().attr("src") ||
      $(".news__detail img").first().attr("src") ||
      $(".topics__detail img").first().attr("src") ||
      $("article img").first().attr("src") ||
      $("main img").first().attr("src");

    const title = cleanTitle(metaTitle);

    const baseDescription =
      cleanLodestoneDescription(metaDescription) ||
      "New Lodestone publication available.";

    const articleText = getArticleText($);

    let finalDescription = baseDescription;
    let dateTimeSection = null;

    if (categoryKey === "topics" || categoryKey === "notices") {
      const firstParagraph = extractFirstParagraph(articleText);

      if (firstParagraph) {
        finalDescription = firstParagraph;
      }
    }

    if (categoryKey === "maintenance" || categoryKey === "updates") {
      dateTimeSection = extractDateTimeSection(articleText);
    }

    const image = metaImage
      ? absoluteUrl(metaImage, articleUrl)
      : fallbackImage
        ? absoluteUrl(fallbackImage, articleUrl)
        : null;

    return {
      title,
      description: finalDescription,
      image,
      dateTimeSection
    };
  } catch (error) {
    console.error(`Unable to fetch article details: ${articleUrl}`);
    return {
      title: null,
      description: "New Lodestone publication available.",
      image: null,
      dateTimeSection: null
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
    const title = cleanTitle(link.text());

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

  const details = await fetchArticleDetails(item.url, item.categoryKey);

  const finalTitle = details.title || item.title;
  const finalDescription =
    details.description || "New Lodestone publication available.";
  const finalImage = details.image || item.image;

  const embed = new EmbedBuilder()
    .setAuthor({
      name: `The Lodestone - ${item.categoryLabel}`
    })
    .setTitle(`${item.emoji} ${cleanTitle(finalTitle)}`)
    .setURL(item.url)
    .setDescription(finalDescription)
    .addFields({
      name: "Link",
      value: `[Open the article on The Lodestone](${item.url})`
    })
    .setColor(item.color)
    .setFooter({
      text: "FINAL FANTASY XIV - The Lodestone"
    })
    .setTimestamp(new Date());

  if (details.dateTimeSection) {
    embed.addFields({
      name: "[Date & Time]",
      value: details.dateTimeSection
    });
  }

  if (finalImage) {
    embed.setImage(finalImage);
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
