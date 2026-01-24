const axios = require('axios');
const yts = require('yt-search');
const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const { Octokit } = require('@octokit/rest');
const moment = require('moment-timezone');
const xv = require("xv-scraper");
const xnxx = require("xnxx-scraper");
const fetch = require('node-fetch');
const cheerio = require("cheerio");
const bodyparser = require('body-parser');
const { Buffer } = require('buffer');
const FileType = require('file-type');
const { File } = require('megajs');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser
} = require('baileys');



// function 
//song download 
async function ytmp3(link, format = "mp3") {
  try {
    // 1. Access yt.savetube.me to get initial page (optional if you want to parse hidden values)
    const pageRes = await axios.get("https://v6.www-y2mate.com", {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127 Safari/537.36",
      },
    });

    // Load the HTML if you want to scrape tokens/keys (in case they use CSRF or hidden params)
    const $ = cheerio.load(pageRes.data);

    // 2. Create a conversion task
    const createUrl = `https://loader.to/ajax/download.php?button=1&format=${format}&url=${encodeURIComponent(
      link
    )}`;
    const createRes = await axios.get(createUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127 Safari/537.36",
        Referer: "https://v6.www-y2mate.com/",
      },
    });

    if (!createRes.data.success || !createRes.data.id) {
      throw new Error("Failed to create task. Invalid link or format.");
    }

    const taskId = createRes.data.id;

    // 3. Poll progress until the download link is ready
    let downloadUrl = null;
    let title = "";
    let thumbnail = "";

    while (!downloadUrl) {
      await new Promise((r) => setTimeout(r, 3000)); // wait 3s between polls

      const statusUrl = `https://loader.to/ajax/progress.php?id=${taskId}`;
      const statusRes = await axios.get(statusUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127 Safari/537.36",
          Referer: "https://v6.www-y2mate.com/",
        },
      });

      if (statusRes.data.download_url) {
        downloadUrl = statusRes.data.download_url;
        title = statusRes.data.title || "";
        thumbnail = statusRes.data.thumbnail || "";
      } else if (statusRes.data.error) {
        throw new Error("Conversion failed: " + statusRes.data.error);
      }
    }

    // 4. Return structured result
    return {
      title,
      Created_by: 'manaofc',
      thumbnail,
      format,
      downloadUrl: downloadUrl,
    };
  } catch (err) {
    console.error("ytmp3 error:", err.message);
    return null;
  }
}

// gdrive download
async function GDriveDl(url) {
    let id;
    if (!(url && url.match(/drive\.google/i))) return { error: true };

    try {
        id = (url.match(/[-\w]{25,}/) || [null])[0];
        if (!id) return { error: true };

        const res = await fetch(`https://drive.google.com/uc?id=${id}&export=download`);
        const html = await res.text();

        if (html.includes("Quota exceeded")) {
            return { error: true, message: "⚠️ Download quota exceeded." };
        }

        const $ = cheerio.load(html);
        const fileName =
            $("title").text().replace(" - Google Drive", "").trim() || "Unknown";
        const fileSize =
            $("span.uc-name-size").text().replace(fileName, "").trim() || "Unknown";

        const downloadUrl = `https://drive.google.com/uc?export=download&id=${id}`;

        return { fileName, fileSize, downloadUrl };
    } catch (e) {
        return { error: true, message: e.message };
    }
}
 
// Default config structure
const defaultConfig = {
    AUTO_VIEW_STATUS: 'false',
    AUTO_LIKE_STATUS: 'false',
    AUTO_RECORDING: 'true',
    AUTO_LIKE_EMOJI: ['💥', '👍', '😍', '💗', '🎈', '🎉', '🥳', '😎', '🚀', '🔥'],
    PREFIX: '.',
    MAX_RETRIES: 3,
    ADMIN_LIST_PATH: './admin.json',
    IMAGE_PATH: 'https://i.ibb.co/6RzcnLWR/jpg.jpg',
    OWNER_NUMBER: '94759934522'
};

// GitHub Octokit initialization
let octokit;
if (process.env.GITHUB_TOKEN) {
    octokit = new Octokit({
        auth: process.env.GITHUB_TOKEN
    });
}
const owner = process.env.GITHUB_REPO_OWNER || "manaofc";
const repo = process.env.GITHUB_REPO_NAME || "manaofc-minibot";

// Memory optimization: Use weak references for sockets
const activeSockets = new Map();
const socketCreationTime = new Map();
const SESSION_BASE_PATH = './session';
const NUMBER_LIST_PATH = './numbers.json';

// Memory optimization: Cache frequently used data
let adminCache = null;
let adminCacheTime = 0;
const ADMIN_CACHE_TTL = 86400000; // 24 hour

// Initialize directories
if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
}

// Memory optimization: Improved admin loading with caching
function loadAdmins() {
    try {
        const now = Date.now();
        if (adminCache && now - adminCacheTime < ADMIN_CACHE_TTL) {
            return adminCache;
        }
        
        if (fs.existsSync(defaultConfig.ADMIN_LIST_PATH)) {
            adminCache = JSON.parse(fs.readFileSync(defaultConfig.ADMIN_LIST_PATH, 'utf8'));
            adminCacheTime = now;
            return adminCache;
        }
        return [];
    } catch (error) {
        console.error('Failed to load admin list:', error);
        return [];
    }
}

// Memory optimization: Use template literals efficiently
function formatMessage(title, content, footer) {
    return `*${title}*\n\n${content}\n\n> *${footer}*`;
}

function getSriLankaTimestamp() {
    return moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss');
}

// Memory optimization: Clean up unused variables and optimize loops
async function cleanDuplicateFiles(number) {
    try {
        if (!octokit) return;
        
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file => 
            file.name.startsWith(`creds_${sanitizedNumber}_`) && file.name.endsWith('.json')
        ).sort((a, b) => {
            const timeA = parseInt(a.name.match(/creds_\d+_(\d+)\.json/)?.[1] || 0);
            const timeB = parseInt(b.name.match(/creds_\d+_(\d+)\.json/)?.[1] || 0);
            return timeB - timeA;
        });

        // Keep only the first (newest) file, delete the rest
        if (sessionFiles.length > 1) {
            for (let i = 1; i < sessionFiles.length; i++) {
                await octokit.repos.deleteFile({
                    owner,
                    repo,
                    path: `session/${sessionFiles[i].name}`,
                    message: `Delete duplicate session file for ${sanitizedNumber}`,
                    sha: sessionFiles[i].sha
                });
                console.log(`Deleted duplicate session file: ${sessionFiles[i].name}`);
            }
        }
    } catch (error) {
        console.error(`Failed to clean duplicate files for ${number}:`, error);
    }
}

// Memory optimization: Reduce memory usage in message sending
async function sendAdminConnectMessage(socket, number) {
    const admins = loadAdmins();
    const caption = formatMessage(
        'Bot Connected',
        `📞 Number: ${number}\nBots: Connected`,
        '*ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy ᴍᴀɴᴀᴏꜰᴄ*'
    );

    // Send messages sequentially to avoid memory spikes
    for (const admin of admins) {
        try {
            await socket.sendMessage(
                `${admin}@s.whatsapp.net`,
                {
                    image: { url: defaultConfig.IMAGE_PATH },
                    caption
                }
            );
            // Add a small delay to prevent rate limiting and memory buildup
            await delay(100);
        } catch (error) {
            console.error(`Failed to send connect message to admin ${admin}:`, error);
        }
    }
}

// Memory optimization: Cache the about status to avoid repeated updates
let lastAboutUpdate = 0;
const ABOUT_UPDATE_INTERVAL = 3600000; // 1 hour

async function updateAboutStatus(socket) {
    const now = Date.now();
    if (now - lastAboutUpdate < ABOUT_UPDATE_INTERVAL) {
        return; // Skip update if it was done recently
    }
    
    const aboutStatus = 'ᴍᴀɴɪꜱʜᴀ-ᴍᴅ-ᴍɪɴɪ ʙᴏᴛ ᴀᴄᴛɪᴠᴇᴛᴅ 🚀';
    try {
        await socket.updateProfileStatus(aboutStatus);
        lastAboutUpdate = now;
        console.log(`Updated About status to: ${aboutStatus}`);
    } catch (error) {
        console.error('Failed to update About status:', error);
    }
}

// Memory optimization: Limit story updates
let lastStoryUpdate = 0;
const STORY_UPDATE_INTERVAL = 86400000; // 24 hours

async function updateStoryStatus(socket) {
    const now = Date.now();
    if (now - lastStoryUpdate < STORY_UPDATE_INTERVAL) {
        return; // Skip update if it was done recently
    }
    
    const statusMessage = `Connected! 🚀\nConnected at: ${getSriLankaTimestamp()}`;
    try {
        await socket.sendMessage('status@broadcast', { text: statusMessage });
        lastStoryUpdate = now;
        console.log(`Posted story status: ${statusMessage}`);
    } catch (error) {
        console.error('Failed to post story status:', error);
    }
}

// Memory optimization: Throttle status handlers
function setupStatusHandlers(socket, userConfig) {
    let lastStatusInteraction = 0;
    const STATUS_INTERACTION_COOLDOWN = 10000; // 10 seconds
    
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key || message.key.remoteJid !== 'status@broadcast' || !message.key.participant) return;
        
        // Throttle status interactions to prevent spam
        const now = Date.now();
        if (now - lastStatusInteraction < STATUS_INTERACTION_COOLDOWN) {
            return;
        }

        try {
            if (userConfig.AUTO_RECORDING === 'true' && message.key.remoteJid) {
                await socket.sendPresenceUpdate("recording", message.key.remoteJid);
            }

            if (userConfig.AUTO_VIEW_STATUS === 'true') {
                let retries = parseInt(userConfig.MAX_RETRIES) || 3;
                while (retries > 0) {
                    try {
                        await socket.readMessages([message.key]);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to read status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (parseInt(userConfig.MAX_RETRIES) || 3 - retries));
                    }
                }
            }

            if (userConfig.AUTO_LIKE_STATUS === 'true') {
                const emojis = Array.isArray(userConfig.AUTO_LIKE_EMOJI) ? 
                    userConfig.AUTO_LIKE_EMOJI : defaultConfig.AUTO_LIKE_EMOJI;
                const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
                let retries = parseInt(userConfig.MAX_RETRIES) || 3;
                while (retries > 0) {
                    try {
                        await socket.sendMessage(
                            message.key.remoteJid,
                            { react: { text: randomEmoji, key: message.key } },
                            { statusJidList: [message.key.participant] }
                        );
                        lastStatusInteraction = now;
                        console.log(`Reacted to status with ${randomEmoji}`);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to react to status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (parseInt(userConfig.MAX_RETRIES) || 3 - retries));
                    }
                }
            }
        } catch (error) {
            console.error('Status handler error:', error);
        }
    });
}
async function handleMessageRevocation(socket, number) {
    socket.ev.on('messages.delete', async ({ keys }) => {
        if (!keys || keys.length === 0) return;

        const messageKey = keys[0];
        const userJid = jidNormalizedUser(socket.user.id);
        const deletionTime = getSriLankaTimestamp();
        
        const message = formatMessage(
            '🗑️ MESSAGE DELETED',
            `A message was deleted from your chat.\n🧚‍♂️ From: ${messageKey.remoteJid}\n🍁 Deletion Time: ${deletionTime}`,
            '> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy ᴍᴀɴᴀᴏꜰᴄ*'
        );

        try {
            await socket.sendMessage(userJid, {
                image: { url: defaultConfig.IMAGE_PATH },
                caption: message
            });
            console.log(`Notified ${number} about message deletion: ${messageKey.id}`);
        } catch (error) {
            console.error('Failed to send deletion notification:', error);
        }
    });
} 
// Memory optimization: Streamline command handlers with rate limiting
function setupCommandHandlers(socket, number, userConfig) {
    const commandCooldowns = new Map();
    const COMMAND_COOLDOWN = 1000; // 1 second per user
    
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        const newsletterJids = ["120@newsletter"];
  const emojis = ["🫡", "💪"];

  if (msg.key && newsletterJids.includes(msg.key.remoteJid)) {
    try {
      const serverId = msg.newsletterServerId;
      if (serverId) {
      const emoji = emojis[Math.floor(Math.random() * emojis.length)];
        await conn.newsletterReactMessage(msg.key.remoteJid, serverId.toString(), emoji);
      }
    } catch (e) {
    
    }
  }	  
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

        // Extract text from different message types
        let text = '';
        if (msg.message.conversation) {
            text = msg.message.conversation.trim();
        } else if (msg.message.extendedTextMessage?.text) {
            text = msg.message.extendedTextMessage.text.trim();
        } else if (msg.message.buttonsResponseMessage?.selectedButtonId) {
            text = msg.message.buttonsResponseMessage.selectedButtonId.trim();
        } else if (msg.message.imageMessage?.caption) {
            text = msg.message.imageMessage.caption.trim();
        } else if (msg.message.videoMessage?.caption) {
            text = msg.message.videoMessage.caption.trim();
        }

        // Check if it's a command
        const prefix = userConfig.PREFIX || '.';
        if (!text.startsWith(prefix)) return;
        
        // Rate limiting
        const sender = msg.key.remoteJid;
        const now = Date.now();
        if (commandCooldowns.has(sender) && now - commandCooldowns.get(sender) < COMMAND_COOLDOWN) {
            return;
        }
        commandCooldowns.set(sender, now);

        const parts = text.slice(prefix.length).trim().split(/\s+/);
        const command = parts[0].toLowerCase();
        const args = parts.slice(1);

        try {
            switch (command) {
// main alive
                case 'alive': {
                    const startTime = socketCreationTime.get(number) || Date.now();
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);

                    const caption = `
╭───『 🤖 𝐁𝐎𝐓 𝐀𝐂𝐓𝐈𝐕𝐄 』───╮
│ ⏰ *ᴜᴘᴛɪᴍᴇ:* ${hours}h ${minutes}m ${seconds}s
│ 🟢 *ᴀᴄᴛɪᴠᴇ sᴇssɪᴏɴs:* ${activeSockets.size}
│ 📱 *ʏᴏᴜʀ ɴᴜᴍʙᴇʀ:* ${number}
╰──────────────────╯

> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy ᴍᴀɴᴀᴏꜰᴄ*
`;

                    await socket.sendMessage(sender, {
                        image: { url: defaultConfig.IMAGE_PATH },
                        caption: caption.trim()
                    });
                    break;           
                }
                    
// xvideo download 
                    
                case 'xv': {
    try {
        const q = args.join(" "); // ⚡ Make sure q is defined
        if (!q) {
            return socket.sendMessage(sender, {
                text: "❌ *Please provide a video link or search keyword!*"
            });
        }

        let info;

        // 🔍 Link or Search
        if (q.startsWith("http")) {
            info = await xv.xInfo(q);
        } else {
            const results = await xv.xsearch(q);
            if (!results || results.length === 0) {
                return socket.sendMessage(sender, {
                    text: "❌ No results found for your keyword."
                });
            }
            info = await xv.xInfo(results[0].url);
        }

        if (!info?.dlink) {
            return socket.sendMessage(sender, {
                text: "❌ Failed to fetch downloadable link for this video."
            });
        }

        const caption = `
╭───『 🔞 𝐗𝐕𝐈𝐃𝐄𝐎 𝐃𝐎𝐖𝐍𝐋𝐎𝐀𝐃𝐄𝐑 』───╮
│ 🎬 *Title:* ${info.title}
│ ⏱️ *Duration:* ${info.duration}
│ 👀 *Views:* ${info.views}
╰──────────────────────────╯
        `.trim();

        // ⬇️ Download & Send Video
        await socket.sendMessage(sender, {
            video: { url: info.dlink },
            caption
        });

    } catch (err) {
        console.error("XV ERROR:", err);
        await socket.sendMessage(sender, {
            text: `❌ Error: ${err.message || "Failed to fetch/download video"}`
        });
    }
    break;
}
                    
// xnxx download
                    
case 'xn': {
    try {
        const q = args.join(" "); // ⚡ Make sure q is defined
        if (!q) {
            return socket.sendMessage(sender, {
                text: "❌ Please provide a video link or search keyword."
            });
        }

        let info;

        // 🔍 Link or search
        if (q.startsWith("http")) {
            info = await xnxx.getVideoInfo(q);
        } else {
            const results = await xnxx.searchVideos(q);
            if (!results || results.length === 0) {
                return socket.sendMessage(sender, {
                    text: "❌ No results found for your keyword."
                });
            }
            info = await xnxx.getVideoInfo(results[0].url);
        }

        const caption = `
╭───『 🎥 XNXX DOWNLOADER 』───╮
│ 📌 Title: ${info.title}
│ ⏱ Duration: ${info.duration}
│ 👀 Views: ${info.views}
│ 👍 Likes: ${info.likes}
│ ⭐ Rating: ${info.rating}
╰──────────────────────────╯
        `.trim();

        
        // 🎬 Send video directly
        await socket.sendMessage(sender, {
            video: { url: info.dlink },
            caption }); 
        

    } catch (err) {
        console.error("XNXX ERROR:", err);
        await socket.sendMessage(sender, {
            text: `❌ Error while fetching/downloading video.\n${err.message || "Unknown error"}`
        });
    }
    break; 
}
// song download 
        case 'song': {
    try {
        const q = args.join(" "); // ⚡ Song name or YouTube URL
        if (!q) {
            return socket.sendMessage(sender, {
                text: "❌ Please provide a song name or YouTube URL."
            });
        }

        // 🔍 Search or direct link
        let data;
        if (q.startsWith("http")) {
            const search = await yts(q);
            if (!search.videos || search.videos.length === 0)
                return socket.sendMessage(sender, { text: "❌ No results found!" });
            data = search.videos[0];
        } else {
            const search = await yts(q);
            if (!search.videos || search.videos.length === 0)
                return socket.sendMessage(sender, { text: "❌ No results found!" });
            data = search.videos[0];
        }

        const url = data.url;

        const caption = `
╭───『 🎧 SONG DOWNLOADER 』───╮
│ 📌 Title: ${data.title}
│ ⏱ Duration: ${data.timestamp}
│ 👀 Views: ${data.views}
│ 📅 Uploaded: ${data.ago}
╰──────────────────────────╯
Downloading audio... 🎵
        `.trim();

        // ⚡ Send "Downloading" message
        await socket.sendMessage(sender, { text: "⬇️ Downloading song..." });

        // 🎵 Download MP3 (replace ytmp3 with your download function)
        const result = await ytmp3(url, "mp3");
        if (!result?.downloadUrl) {
            return socket.sendMessage(sender, { text: "❌ Failed to download audio!" });
        }

        const downloadLink = result.downloadUrl;

        // 🎶 Send Audio File directly
        await socket.sendMessage(sender, {
            audio: { url: downloadLink },
            caption
        });
        
    } catch (err) {
        console.error("SONG ERROR:", err);
        await socket.sendMessage(sender, {
            text: `❌ Error while fetching/downloading song.\n${err.message || "Unknown error"}`
        });
    }
    break;
}
                
//apk download
                    
        case 'apk': {
    try {
        const q = args.join(" "); // ✅ Make sure q is defined
        if (!q) {
            return socket.sendMessage(sender, {
                text: "❌ *Please provide an app name to search!*"
            });
        }

        const apiUrl = `http://ws75.aptoide.com/api/7/apps/search/query=${encodeURIComponent(q)}/limit=1`;
        const res = await axios.get(apiUrl);
        const data = res.data;

        if (!data?.datalist?.list || data.datalist.list.length === 0) {
            return socket.sendMessage(sender, {
                text: "⚠️ *No results found for the given app name.*"
            });
        }

        const app = data.datalist.list[0];
        const appSize = (app.size / 1048576).toFixed(2); // MB
        const thumb = app.icon;
        const apkUrl = app.file?.path_alt;

        if (!apkUrl) {
            return socket.sendMessage(sender, {
                text: "❌ *Failed to fetch APK download link.*"
            });
        }

        const caption = `
╭───『 📱 APK DOWNLOADER 』───╮
│ 📦 *Name:* ${app.name}
│ 🆔 *Package:* ${app.package}
│ 💾 *Size:* ${appSize} MB
│ 👨‍💻 *Developer:* ${app.developer.name}
│ 🗓️ *Updated:* ${app.updated}
╰──────────────────────────╯
        `.trim();

        // 🖼️ App info
        await socket.sendMessage(sender, {
            image: { url: thumb },
            caption
        });

        // ⬇️ Send APK
        await socket.sendMessage(sender, {
            document: { url: apkUrl },
            fileName: `${app.name}.apk`.replace(/[^\w\s.-]/gi, ''),
            mimetype: "application/vnd.android.package-archive"
        });

    } catch (err) {
        console.error("APK ERROR:", err);
        await socket.sendMessage(sender, {
            text: `❌ Error: ${err.message || "Failed to download APK"}`
        });
    }
    break;
}
                    
// gdrivre download 
                    
                case 'gdrive':{
                    try {
                        const q = args.join(" ");
        if (!q || !q.startsWith("http")) {
            return socket.sendMessage(sender, {
                text: "❗ Please provide a valid Google Drive link."
            });
        }

        const file = await GDriveDl(q);
        if (file.error) {
            return socket.sendMessage(sender, {
                text: "❌ Failed: " + (file.message || "Unable to fetch file.")
            });
        }

        let sizeMB = 0;
        if (file.fileSize.includes("MB")) {
            sizeMB = parseFloat(file.fileSize);
        } else if (file.fileSize.includes("GB")) {
            sizeMB = parseFloat(file.fileSize) * 1024;
        }

        if (sizeMB > 1900) {
            return socket.sendMessage(sender, {
                text:
`📄 ${file.fileName}
📦 Size: ${file.fileSize}

⚠️ File too large for WhatsApp.
⬇️ Download manually:
${file.downloadUrl}`
            });
        }

        await socket.sendMessage(sender, {
            document: { url: file.downloadUrl },
            fileName: file.fileName,
            mimetype: "application/octet-stream",
            caption: `📄 ${file.fileName}\n📦 Size: ${file.fileSize}`
        });

    } catch (err) {
        console.error("GDRIVE ERROR:", err);
        socket.sendMessage(sender, {
            text: "❌ Error while processing Google Drive link."
        });
    }
    break;
}
                    
 // mega download 
                    
 case 'mega': {
    try {
        const q = args.join(" ");
        if (!q) {
            return socket.sendMessage(sender, {
                text: "❗ Please provide a MEGA.nz link."
            });
        }

        const file = File.fromURL(q);
        await file.loadAttributes();

        const maxSize = 4 * 1024 * 1024 * 1024; // 4GB
        if (file.size > maxSize) {
            return socket.sendMessage(sender, {
                text:
`❌ File too large
Max: 4GB
Size: ${(file.size / (1024 ** 3)).toFixed(2)} GB`
            });
        }

        await socket.sendMessage(sender, {
            text: `⬇️ Downloading ${file.name} (${(file.size / (1024 ** 2)).toFixed(2)} MB)...`
        });

        const buffer = await file.downloadBuffer();
        const mimeType = mime.lookup(file.name) || "application/octet-stream";

        await socket.sendMessage(sender, {
            document: buffer,
            fileName: file.name,
            mimetype: mimeType
        });

    } catch (err) {
        console.error("MEGA ERROR:", err);
        socket.sendMessage(sender, {
            text: "❌ Failed to download MEGA file."
        });
    }
    break;
}
                    
//mediafire download 
                    
case 'mfire': {
    try {
        const q = args.join(" ");
        if (!q || !q.startsWith("https://")) {
            return socket.sendMessage(sender, {
                text: "❗ Please provide a valid MediaFire link."
            });
        }

        const res = await fetch(q);
        const html = await res.text();
        const $ = cheerio.load(html);

        const fileName = $(".dl-info .filename").text().trim();
        const downloadUrl = $("#downloadButton").attr("href");
        const fileType = $(".dl-info .filetype").text().trim();
        const fileSize = $(".dl-info ul li span").first().text().trim();
        const fileDate = $(".dl-info ul li span").last().text().trim();

        if (!fileName || !downloadUrl) {
            return socket.sendMessage(sender, {
                text: "⚠️ Failed to extract MediaFire info."
            });
        }

        const ext = fileName.split(".").pop().toLowerCase();
        const mimeTypes = {
            zip: "application/zip",
            pdf: "application/pdf",
            mp4: "video/mp4",
            mkv: "video/x-matroska",
            mp3: "audio/mpeg",
            "7z": "application/x-7z-compressed",
            jpg: "image/jpeg",
            jpeg: "image/jpeg",
            png: "image/png",
            rar: "application/x-rar-compressed"
        };

        await socket.sendMessage(sender, {
            document: { url: downloadUrl },
            fileName,
            mimetype: mimeTypes[ext] || "application/octet-stream",
            caption:
`📄 ${fileName}
📁 Type: ${fileType}
📦 Size: ${fileSize}
📅 Uploaded: ${fileDate}`
        });

    } catch (err) {
        console.error("MEDIAFIRE ERROR:", err);
        socket.sendMessage(sender, {
            text: "❌ Error while processing MediaFire link."
        });
    }
    break;
}
 
 // bot setting
                 case 'settings': {
                    if (args[0] === 'set' && args.length >= 3) {
                        const configKey = args[1].toUpperCase();
                        const configValue = args.slice(2).join(' ');
                        
                        // Handle array values
                        if (configKey === 'AUTO_LIKE_EMOJI') {
                            userConfig[configKey] = configValue.split(',');
                        } else {
                            userConfig[configKey] = configValue;
                        }
                        
                        await updateUserConfig(number, userConfig);
                        
                        await socket.sendMessage(sender, {
                            text: `✅ settings updated: ${configKey} = ${configValue}\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy ᴍᴀɴᴀᴏꜰᴄ*`
                        });
                    } else if (args[0] === 'view') {
                        let configText = '*📋 Your Current Config:*\n\n';
                        for (const [key, value] of Object.entries(userConfig)) {
                            configText += `• ${key}: ${Array.isArray(value) ? value.join(', ') : value}\n`;
                        }
                        configText += '\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy ᴍᴀɴᴀᴏꜰᴄ*';
                        
                        await socket.sendMessage(sender, { text: configText });
                    } else {
                        await socket.sendMessage(sender, {
                            text: `❌ Invalid settings command. Usage:\n${prefix}settings set [key] [value]\n${prefix}settings view\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy ᴍᴀɴᴀᴏꜰᴄ*`
                        });
                    }
                    break;
                }
// main menu
                case 'menu': {
                    const startTime = socketCreationTime.get(number) || Date.now();
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);

                    const os = require('os');
                    const ramUsage = Math.round(process.memoryUsage().rss / 1024 / 1024);
                    const totalRam = Math.round(os.totalmem() / 1024 / 1024);

                    const menuCaption = `
👋 *Hi ${number}*

╭───『 *MANISHA-MD-MINI BOT IS ACTIVETE* 』
│ 👾 *ʙᴏᴛ*: MANISHA-MD
│ 📞 *ᴏᴡɴᴇʀ*: ᴍᴀɴᴀᴏꜰᴄ
│ ⏳ *ᴜᴘᴛɪᴍᴇ*: ${hours}h ${minutes}m ${seconds}s
│ 📂 *ʀᴀᴍ*: ${ramUsage}MB / ${totalRam}MB
│ ✏️ *ᴘʀᴇғɪx*: ${prefix}
╰─────────────────────╯

⚡ Commands list

main commands:

- ${prefix}alive
- ${prefix}menu
- ${prefix}ping
- ${prefix}uptime
- ${prefix}repo

download commands:

- ${prefix}xv
- ${prefix}xv
- ${prefix}mfire
- ${prefix}mega
- ${prefix}gdrive

settings commands:

- ${prefix}settings

owner commands:

- ${prefix}tagall
- ${prefix}deleteme / confirm
- ${prefix}getpp <number> - Get profile picture of any number
`;

                    await socket.sendMessage(sender, {
                        image: { url: defaultConfig.IMAGE_PATH },
                        caption: menuCaption.trim()
                    });
                    break;
                }

// ping
               case 'ping': {
                    const start = Date.now();
                    await socket.sendMessage(sender, { text: '🏓 Pong!' });
                    const latency = Date.now() - start;

             await socket.sendMessage(sender, {
                        image: { url: defaultConfig.IMAGE_PATH },
                        caption:  `⚡ *Latency:* ${latency}ms\n📶 *Connection:* ${latency < 500 ? 'Excellent' : latency < 1000 ? 'Good' : 'Poor'}\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy ᴍᴀɴᴀᴏꜰᴄ* `
                    });
                    break;
                } 
// uptime
                
                case 'uptime': {
                    const startTime = socketCreationTime.get(number) || Date.now();
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);
                    await socket.sendMessage(sender, {
                        image: { url: defaultConfig.IMAGE_PATH },
                        caption:  `⏰ *Uptime:* ${hours}h ${minutes}m ${seconds}s\n📊 *Active Sessions:* ${activeSockets.size}\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy ᴍᴀɴᴀᴏꜰᴄ*`
                    });
                   
                    break;
                }
// tagall

                case 'tagall': {
                    if (!msg.key.remoteJid.endsWith('@g.us')) {
                        await socket.sendMessage(sender, { text: '❌ This command can only be used in groups.' });
                        return;
                    }
                    const groupMetadata = await socket.groupMetadata(sender);
                    const participants = groupMetadata.participants.map(p => p.id);
                    const tagMessage = `📢 *Tagging all members:*\n\n${participants.map(p => `@${p.split('@')[0]}`).join(' ')}`;
                    
                    await socket.sendMessage(sender, {
                        text: tagMessage,
                        mentions: participants
                    });
                    break;
                }
// repo
                case 'repo': {
                    await socket.sendMessage(sender, {
                        image: { url: defaultConfig.IMAGE_PATH },
                        caption: `📦 *MANISHA-MD-MINI BOT REPOSITORY*\n\n🔗 *GitHub:* https://github.com/manaofc/manaofc-minibot\n\n🌟 *Features:*\n• Fast & Reliable\n• Easy to Use\n• Multiple Sessions\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy ᴍᴀɴᴀᴏꜰᴄ*`
                    });
                    break;
                }
// getpp
                case 'getpp': {
                    if (args.length === 0) {
                        await socket.sendMessage(sender, { 
                            text: `❌ Please provide a phone number.\nUsage: ${prefix}getpp <number>\nExample: ${prefix}getpp 94759934522\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy ᴍᴀɴᴀᴏꜰᴄ*` 
                        });
                        return;
                    }
                    
                    let targetNumber = args[0].replace(/[^0-9]/g, '');
                    
                    // Add country code if not provided
                    if (!targetNumber.startsWith('92') && targetNumber.length === 10) {
                        targetNumber = '92' + targetNumber;
                    }
                    
                    // Ensure it has @s.whatsapp.net
                    const targetJid = targetNumber.includes('@') ? targetNumber : `${targetNumber}@s.whatsapp.net`;
                    
                    await socket.sendMessage(sender, { 
                        text: `🕵️ Stealing profile picture for ${targetNumber}...\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy ᴍᴀɴᴀᴏꜰᴄ*` 
                    });
                    
                    try {
                        // Get profile picture URL
                        const profilePictureUrl = await socket.profilePictureUrl(targetJid, 'image');
                        
                        if (profilePictureUrl) {
                            await socket.sendMessage(sender, {
                                image: { url: profilePictureUrl },
                                caption: `✅ Successfully stole profile picture!\n📱 Number: ${targetNumber}\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy ᴍᴀɴᴀᴏꜰᴄ*`
                            });
                        } else {
                            await socket.sendMessage(sender, { 
                                text: `❌ No profile picture found for ${targetNumber}\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy ᴍᴀɴᴀᴏꜰᴄ*` 
                            });
                        }
                        
                    } catch (error) {
                        console.error('Profile picture steal error:', error);
                        
                        if (error.message.includes('404') || error.message.includes('not found')) {
                            await socket.sendMessage(sender, { 
                                text: `❌ No profile picture found for ${targetNumber}\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy ᴍᴀɴᴀᴏꜰᴄ*` 
                            });
                        } else {
                            await socket.sendMessage(sender, { 
                                text: `❌ Error stealing profile picture: ${error.message}\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy ᴍᴀɴᴀᴏꜰᴄ*` 
                            });
                        }
                    }
                    break;
                }
// deletme
                case 'deleteme': {
                    const confirmationMessage = `⚠️ *Are you sure you want to delete your session?*\n\nThis action will:\n• Log out your bot\n• Delete all session data\n• Require re-pairing to use again\n\nReply with *${prefix}confirm* to proceed or ignore to cancel.`;
                    
                    await socket.sendMessage(sender, {
                        image: { url: defaultConfig.IMAGE_PATH },
                        caption: confirmationMessage + '\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy ᴍᴀɴᴀᴏꜰᴄ*'
                    });
                    break;
                }
// confirm
                case 'confirm': {
                    // Handle session deletion confirmation
                    const sanitizedNumber = number.replace(/[^0-9]/g, '');
                    
                    await socket.sendMessage(sender, {
                        text: '🗑️ Deleting your session...\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy ᴍᴀɴᴀᴏꜰᴄ*'
                    });
                    
                    try {
                        // Close the socket connection
                        const socket = activeSockets.get(sanitizedNumber);
                        if (socket) {
                            socket.ws.close();
                            activeSockets.delete(sanitizedNumber);
                            socketCreationTime.delete(sanitizedNumber);
                        }
                        
                        // Delete session files
                        const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
                        if (fs.existsSync(sessionPath)) {
                            fs.removeSync(sessionPath);
                        }
                        
                        // Delete from GitHub if octokit is available
                        if (octokit) {
                            await deleteSessionFromGitHub(sanitizedNumber);
                        }
                        
                        // Remove from numbers list
                        let numbers = [];
                        if (fs.existsSync(NUMBER_LIST_PATH)) {
                            numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
                        }
                        const index = numbers.indexOf(sanitizedNumber);
                        if (index !== -1) {
                            numbers.splice(index, 1);
                            fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
                        }
                        
                        await socket.sendMessage(sender, {
                            text: '✅ Your session has been successfully deleted!\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy ᴍᴀɴᴀᴏꜰᴄ*'
                        });
                    } catch (error) {
                        console.error('Failed to delete session:', error);
                        await socket.sendMessage(sender, {
                            text: '❌ Failed to delete your session. Please try again later.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy ᴍᴀɴᴀᴏꜰᴄ*'
                        });
                    }
                    break;
                }
                
                

                default: {
                    await socket.sendMessage(sender, {
                        text: `❌ Unknown command: ${command}\nUse ${prefix}menu to see available commands.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy ᴍᴀɴᴀᴏꜰᴄ*`
                    });
                    break;
                }
            }
        } catch (error) {
            console.error('Command handler error:', error);
            await socket.sendMessage(sender, {
                text: `❌ An error occurred while processing your command. Please try again.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy ᴍᴀɴᴀᴏꜰᴄ*`
            });
        }
    });
}

// Memory optimization: Throttle message handlers
function setupMessageHandlers(socket, userConfig) {
    let lastPresenceUpdate = 0;
    const PRESENCE_UPDATE_COOLDOWN = 5000; // 5 seconds
    
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

        // Throttle presence updates
        const now = Date.now();
        if (now - lastPresenceUpdate < PRESENCE_UPDATE_COOLDOWN) {
            return;
        }

        if (userConfig.AUTO_RECORDING === 'true') {
            try {
                await socket.sendPresenceUpdate('recording', msg.key.remoteJid);
                lastPresenceUpdate = now;
                console.log(`Set recording presence for ${msg.key.remoteJid}`);
            } catch (error) {
                console.error('Failed to set recording presence:', error);
            }
        }
    });
}

// Memory optimization: Batch GitHub operations
async function deleteSessionFromGitHub(number) {
    try {
        if (!octokit) return;
        
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file =>
            file.name.includes(sanitizedNumber) && file.name.endsWith('.json')
        );

        // Delete files in sequence to avoid rate limiting
        for (const file of sessionFiles) {
            await octokit.repos.deleteFile({
                owner,
                repo,
                path: `session/${file.name}`,
                message: `Delete session for ${sanitizedNumber}`,
                sha: file.sha
            });
            await delay(500); // Add delay between deletions
        }
    } catch (error) {
        console.error('Failed to delete session from GitHub:', error);
    }
}

// Memory optimization: Cache session data
const sessionCache = new Map();
const SESSION_CACHE_TTL = 300000; // 5 minutes

async function restoreSession(number) {
    try {
        if (!octokit) return null;
        
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        
        // Check cache first
        const cached = sessionCache.get(sanitizedNumber);
        if (cached && Date.now() - cached.timestamp < SESSION_CACHE_TTL) {
            return cached.data;
        }
        
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file =>
            file.name === `creds_${sanitizedNumber}.json`
        );

        if (sessionFiles.length === 0) return null;

        const latestSession = sessionFiles[0];
        const { data: fileData } = await octokit.repos.getContent({
            owner,
            repo,
            path: `session/${latestSession.name}`
        });

        const content = Buffer.from(fileData.content, 'base64').toString('utf8');
        const sessionData = JSON.parse(content);
        
        // Cache the session data
        sessionCache.set(sanitizedNumber, {
            data: sessionData,
            timestamp: Date.now()
        });
        
        return sessionData;
    } catch (error) {
        console.error('Session restore failed:', error);
        return null;
    }
}

// Memory optimization: Cache user config
const userConfigCache = new Map();
const USER_CONFIG_CACHE_TTL = 300000; // 5 minutes

async function loadUserConfig(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        
        // Check cache first
        const cached = userConfigCache.get(sanitizedNumber);
        if (cached && Date.now() - cached.timestamp < USER_CONFIG_CACHE_TTL) {
            return cached.data;
        }
        
        let configData = { ...defaultConfig };
        
        if (octokit) {
            try {
                const configPath = `session/config_${sanitizedNumber}.json`;
                const { data } = await octokit.repos.getContent({
                    owner,
                    repo,
                    path: configPath
                });

                const content = Buffer.from(data.content, 'base64').toString('utf8');
                const userConfig = JSON.parse(content);
                
                // Merge with default config
                configData = { ...configData, ...userConfig };
            } catch (error) {
                console.warn(`No configuration found for ${number}, using default config`);
            }
        }
        
        // Set owner number to the user's number if not set
        if (!configData.OWNER_NUMBER) {
            configData.OWNER_NUMBER = sanitizedNumber;
        }
        
        // Cache the config
        userConfigCache.set(sanitizedNumber, {
            data: configData,
            timestamp: Date.now()
        });
        
        return configData;
    } catch (error) {
        console.warn(`Error loading config for ${number}, using default config:`, error);
        return { ...defaultConfig, OWNER_NUMBER: number.replace(/[^0-9]/g, '') };
    }
}

async function updateUserConfig(number, newConfig) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        
        if (octokit) {
            const configPath = `session/config_${sanitizedNumber}.json`;
            let sha;

            try {
                const { data } = await octokit.repos.getContent({
                    owner,
                    repo,
                    path: configPath
                });
                sha = data.sha;
            } catch (error) {
                // File doesn't exist yet, no sha needed
            }

            await octokit.repos.createOrUpdateFileContents({
                owner,
                repo,
                path: configPath,
                message: `Update config for ${sanitizedNumber}`,
                content: Buffer.from(JSON.stringify(newConfig, null, 2)).toString('base64'),
                sha
            });
        }
        
        // Update cache
        userConfigCache.set(sanitizedNumber, {
            data: newConfig,
            timestamp: Date.now()
        });
        
        console.log(`Updated config for ${sanitizedNumber}`);
    } catch (error) {
        console.error('Failed to update config:', error);
        throw error;
    }
}

// Memory optimization: Improve auto-restart logic
function setupAutoRestart(socket, number) {
    let restartAttempts = 0;
    const MAX_RESTART_ATTEMPTS = 5;
    const RESTART_DELAY_BASE = 10000; // 10 seconds
    
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close' && lastDisconnect?.error?.output?.statusCode !== 401) {
            // Delete session from GitHub when connection is lost
            await deleteSessionFromGitHub(number);
            
            if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
                console.log(`Max restart attempts reached for ${number}, giving up`);
                activeSockets.delete(number.replace(/[^0-9]/g, ''));
                socketCreationTime.delete(number.replace(/[^0-9]/g, ''));
                return;
            }
            
            restartAttempts++;
            const delayTime = RESTART_DELAY_BASE * Math.pow(2, restartAttempts - 1); // Exponential backoff
            
            console.log(`Connection lost for ${number}, attempting to reconnect in ${delayTime/1000} seconds (attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS})...`);
            
            await delay(delayTime);
            
            try {
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
            } catch (error) {
                console.error(`Reconnection attempt ${restartAttempts} failed for ${number}:`, error);
            }
        } else if (connection === 'open') {
            // Reset restart attempts on successful connection
            restartAttempts = 0;
        }
    });
}

// Memory optimization: Improve pairing process
async function EmpirePair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

    // Check if already connected
    if (activeSockets.has(sanitizedNumber)) {
        if (!res.headersSent) {
            res.send({ 
                status: 'already_connected',
                message: 'This number is already connected'
            });
        }
        return;
    }

    await cleanDuplicateFiles(sanitizedNumber);

    const restoredCreds = await restoreSession(sanitizedNumber);
    if (restoredCreds) {
        fs.ensureDirSync(sessionPath);
        fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(restoredCreds, null, 2));
        console.log(`Successfully restored session for ${sanitizedNumber}`);
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'fatal' : 'debug' });

    try {
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            logger,
            browser: Browsers.windows('Safari')
        });

        socketCreationTime.set(sanitizedNumber, Date.now());

        // Load user config
        const userConfig = await loadUserConfig(sanitizedNumber);
        
        setupStatusHandlers(socket, userConfig);
        setupCommandHandlers(socket, sanitizedNumber, userConfig);
        setupMessageHandlers(socket, userConfig);
        setupAutoRestart(socket, sanitizedNumber);
        handleMessageRevocation(socket, sanitizedNumber); 

        if (!socket.authState.creds.registered) {
            let retries = parseInt(userConfig.MAX_RETRIES) || 3;
            let code;
            while (retries > 0) {
                try {
                    await delay(1500);
                    code = await socket.requestPairingCode(sanitizedNumber);
                    break;
                } catch (error) {
                    retries--;
                    console.warn(`Failed to request pairing code: ${retries}, error.message`, retries);
                    await delay(2000 * ((parseInt(userConfig.MAX_RETRIES) || 3) - retries));
                }
            }
            if (!res.headersSent) {
                res.send({ code });
            }
        }

        socket.ev.on('creds.update', async () => {
            await saveCreds();
            const fileContent = await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf8');
            
            if (octokit) {
                let sha;
                try {
                    const { data } = await octokit.repos.getContent({
                        owner,
                        repo,
                        path: `session/creds_${sanitizedNumber}.json`
                    });
                    sha = data.sha;
                } catch (error) {
                    // File doesn't exist yet, no sha needed
                }

                await octokit.repos.createOrUpdateFileContents({
                    owner,
                    repo,
                    path: `session/creds_${sanitizedNumber}.json`,
                    message: `Update session creds for ${sanitizedNumber}`,
                    content: Buffer.from(fileContent).toString('base64'),
                    sha
                });
                console.log(`Updated creds for ${sanitizedNumber} in GitHub`);
            }
        });

        socket.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                try {
                    await delay(3000);
                    
                    const userJid = jidNormalizedUser(socket.user.id);
   
                                    
                    await updateAboutStatus(socket);
                    await updateStoryStatus(socket);

                    activeSockets.set(sanitizedNumber, socket);

                    await socket.sendMessage(userJid, {
                        image: { url: userConfig.IMAGE_PATH || defaultConfig.IMAGE_PATH},
                        caption: formatMessage(
                            'MANISHA-MD-MINI BOT CONNECTED',
`✅ Successfully connected!\n\n🔢 Number: ${sanitizedNumber}\n\n✨ Bot is now active and ready to use!\n\n📌 Type ${userConfig.PREFIX}menu to view all commands\n\n⚙️ setting change bot\n\n*AUTO VIEW STATUS* ${ defaultConfig. AUTO_VIEW_STATUS ? "Enabled": "Disabled"}\n\n*AUTO LIKE STATUS* ${ userConfig. AUTO_LIKE_STATUS ? "Enabled": "Disabled"}\n\n*AUTO RECORDING ${ userConfig. AUTO_RECORDING ? "Enabled": "Disabled"}\n\n*AUTO LIKE IMOJI ${ userConfig. AUTO_LIKE_IMOJI ? "Enabled": "Disabled"}\n\n_*මෙ ට්ක වෙනස් කරන්න  ${userConfig.PREFIX}setting යන කමාන්ඩ් එක බාවිත කරන්න*_
  `,
'*ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy ᴍᴀɴᴀᴏꜰᴄ*'
                        )
                    });

                    await sendAdminConnectMessage(socket, sanitizedNumber);

                    let numbers = [];
                    if (fs.existsSync(NUMBER_LIST_PATH)) {
                        numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
                    }
                    if (!numbers.includes(sanitizedNumber)) {
                        numbers.push(sanitizedNumber);
                        fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
                    }
                } catch (error) {
                    console.error('Connection error:', error);
                    exec(`pm2 restart ${process.env.PM2_NAME || 'MANISHA-MD-bot-session'}`);
                }
            }
        });
    } catch (error) {
        console.error('Pairing error:', error);
        socketCreationTime.delete(sanitizedNumber);
        if (!res.headersSent) {
            res.status(503).send({ error: 'Service Unavailable' });
        }
    }
}

// API Routes - Only essential routes kept
router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) {
        return res.status(400).send({ error: 'Number parameter is required' });
    }

    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
        return res.status(200).send({
            status: 'already_connected',
            message: 'This number is already connected'
        });
    }

    await EmpirePair(number, res);
});

router.get('/active', (req, res) => {
    res.status(200).send({
        count: activeSockets.size,
        numbers: Array.from(activeSockets.keys())
    });
});

// Memory optimization: Limit concurrent connections
const MAX_CONCURRENT_CONNECTIONS = 5;
let currentConnections = 0;

router.get('/connect-all', async (req, res) => {
    try {
        if (!fs.existsSync(NUMBER_LIST_PATH)) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH));
        if (numbers.length === 0) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const results = [];
        const connectionPromises = [];
        
        for (const number of numbers) {
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }
            
            // Limit concurrent connections
            if (currentConnections >= MAX_CONCURRENT_CONNECTIONS) {
                results.push({ number, status: 'queued' });
                continue;
            }
            
            currentConnections++;
            connectionPromises.push((async () => {
                try {
                    const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                    await EmpirePair(number, mockRes);
                    results.push({ number, status: 'connection_initiated' });
                } catch (error) {
                    results.push({ number, status: 'failed', error: error.message });
                } finally {
                    currentConnections--;
                }
            })());
        }
        
        await Promise.all(connectionPromises);
        
        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Connect all error:', error);
        res.status(500).send({ error: 'Failed to connect all bots' });
    }
});

// Memory optimization: Limit concurrent reconnections
router.get('/reconnect', async (req, res) => {
    try {
        if (!octokit) {
            return res.status(500).send({ error: 'GitHub integration not configured' });
        }
        
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file => 
            file.name.startsWith('creds_') && file.name.endsWith('.json')
        );

        if (sessionFiles.length === 0) {
            return res.status(404).send({ error: 'No session files found in GitHub repository' });
        }

        const results = [];
        const reconnectPromises = [];
        
        for (const file of sessionFiles) {
            const match = file.name.match(/creds_(\d+)\.json/);
            if (!match) {
                console.warn(`Skipping invalid session file: ${file.name}`);
                results.push({ file: file.name, status: 'skipped', reason: 'invalid_file_name' });
                continue;
            }

            const number = match[1];
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }
            
            // Limit concurrent reconnections
            if (currentConnections >= MAX_CONCURRENT_CONNECTIONS) {
                results.push({ number, status: 'queued' });
                continue;
            }
            
            currentConnections++;
            reconnectPromises.push((async () => {
                try {
                    const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                    await EmpirePair(number, mockRes);
                    results.push({ number, status: 'connection_initiated' });
                } catch (error) {
                    console.error(`Failed to reconnect bot for ${number}:`, error);
                    results.push({ number, status: 'failed', error: error.message });
                } finally {
                    currentConnections--;
                }
            })());
        }
        
        await Promise.all(reconnectPromises);
        
        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Reconnect error:', error);
        res.status(500).send({ error: 'Failed to reconnect bots' });
    }
});

// Config management routes for HTML interface
router.get('/config/:number', async (req, res) => {
    try {
        const { number } = req.params;
        const config = await loadUserConfig(number);
        res.status(200).send(config);
    } catch (error) {
        console.error('Failed to load config:', error);
        res.status(500).send({ error: 'Failed to load config' });
    }
});

router.post('/config/:number', async (req, res) => {
    try {
        const { number } = req.params;
        const newConfig = req.body;
        
        // Validate config
        if (typeof newConfig !== 'object') {
            return res.status(400).send({ error: 'Invalid config format' });
        }
        
        // Load current config and merge
        const currentConfig = await loadUserConfig(number);
        const mergedConfig = { ...currentConfig, ...newConfig };
        
        await updateUserConfig(number, mergedConfig);
        res.status(200).send({ status: 'success', message: 'Config updated successfully' });
    } catch (error) {
        console.error('Failed to update config:', error);
        res.status(500).send({ error: 'Failed to update config' });
    }
});

// Cleanup with better memory management
process.on('exit', () => {
    activeSockets.forEach((socket, number) => {
        socket.ws.close();
        activeSockets.delete(number);
        socketCreationTime.delete(number);
    });
    fs.emptyDirSync(SESSION_BASE_PATH);
    
    // Clear all caches
    adminCache = null;
    adminCacheTime = 0;
    sessionCache.clear();
    userConfigCache.clear();
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    exec(`pm2 restart ${process.env.PM2_NAME || 'BOT-session'}`);
});

// Regular memory cleanup
setInterval(() => {
    // Clean up expired cache entries
    const now = Date.now();
    
    // Clean session cache
    for (let [key, value] of sessionCache.entries()) {
        if (now - value.timestamp > SESSION_CACHE_TTL) {
            sessionCache.delete(key);
        }
    }
    
    // Clean user config cache
    for (let [key, value] of userConfigCache.entries()) {
        if (now - value.timestamp > USER_CONFIG_CACHE_TTL) {
            userConfigCache.delete(key);
        }
    }
    
    // Force garbage collection if available
    if (global.gc) {
        global.gc();
    }
}, 300000); // Run every 5 minutes

module.exports = router;
