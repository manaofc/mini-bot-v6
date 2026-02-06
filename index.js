const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 8000;

// ===== Google Drive Direct Download URL =====
const DRIVE_URL = 'https://drive.google.com/uc?export=download&id=1txoH16hqTCBIiWPYofRWrPzNvzUP1SzY';
const BOT_FILE = path.join(__dirname, 'manaofc.js');

// ===== Download bot code from Google Drive =====
function downloadBot(callback) {
    if (fs.existsSync(BOT_FILE)) {
        console.log('✅ Bot code already exists. Skipping download.');
        callback();
        return;
    }

    const file = fs.createWriteStream(BOT_FILE);

    https.get(DRIVE_URL, (response) => {
        response.pipe(file);

        file.on('finish', () => {
            file.close(() => {
                console.log('✅ Bot code downloaded from Google Drive');
                callback();
            });
        });
    }).on('error', (err) => {
        fs.unlink(BOT_FILE, () => {});
        console.error('❌ Download error:', err.message);
    });
}

// ===== Middleware =====
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== Routes =====
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'main.html'));
});

app.get('/bot', (req, res) => {
    res.sendFile(BOT_FILE);
});

// ===== Start Server AFTER bot is downloaded =====
downloadBot(() => {
    // ✅ Simply require the bot code to run it
    require(BOT_FILE); 

    app.listen(PORT, () => {
        console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
});
